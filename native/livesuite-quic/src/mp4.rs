use anyhow::{anyhow, Context, Result};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

const TIMESCALE: u32 = 1_000_000;

#[derive(Debug)]
struct PendingSample {
    pts_us: i64,
    keyframe: bool,
    data: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
struct WrittenSample {
    offset: u64,
    size: u32,
    duration: u32,
    keyframe: bool,
}

#[derive(Clone, Debug)]
struct AudioTrackConfig {
    asc: Vec<u8>,
    sample_rate: u32,
    channels: u8,
    bitrate: u32,
}

#[derive(Debug)]
struct PendingAudioSample {
    pts_us: i64,
    data: Vec<u8>,
}

#[derive(Debug)]
struct WrittenAudioSample {
    size: u32,
    duration: u32,
    data: Vec<u8>,
}

/// Writes H.264 samples without re-encoding.
///
/// While recording, each sample is stored in a crash-tolerant movie fragment.
/// `finish` losslessly rewrites those samples into a regular fast-start MP4 so
/// local players do not need to buffer a sparse fragmented timeline.
#[derive(Debug)]
pub struct FragmentedMp4Recorder {
    path: PathBuf,
    width: u16,
    height: u16,
    default_duration: u32,
    file: Option<File>,
    avc_config: Option<Vec<u8>>,
    pending: Option<PendingSample>,
    video_start_pts_us: Option<i64>,
    sequence: u32,
    decode_time: u64,
    last_duration: u32,
    samples: Vec<WrittenSample>,
    audio_config: Option<AudioTrackConfig>,
    pending_audio: Option<PendingAudioSample>,
    audio_start_pts_us: Option<i64>,
    audio_samples: Vec<WrittenAudioSample>,
    audio_default_duration: u32,
    audio_last_duration: u32,
    finalized: bool,
}

impl FragmentedMp4Recorder {
    pub fn new(path: PathBuf, width: u16, height: u16, fps: u16, _expects_audio: bool) -> Self {
        let default_duration = if fps == 0 {
            TIMESCALE / 30
        } else {
            (TIMESCALE / u32::from(fps)).max(1)
        };
        Self {
            path,
            width,
            height,
            default_duration,
            file: None,
            avc_config: None,
            pending: None,
            video_start_pts_us: None,
            sequence: 0,
            decode_time: 0,
            last_duration: default_duration,
            samples: Vec::new(),
            audio_config: None,
            pending_audio: None,
            audio_start_pts_us: None,
            audio_samples: Vec::new(),
            audio_default_duration: 21_333,
            audio_last_duration: 21_333,
            finalized: false,
        }
    }

    pub fn set_aac_config(
        &mut self,
        config: &[u8],
        sample_rate: u32,
        channels: u8,
        bitrate: u32,
    ) -> Result<()> {
        if config.is_empty() || sample_rate == 0 || !(1..=8).contains(&channels) {
            return Err(anyhow!("invalid AAC track configuration"));
        }
        if let Some(current) = &self.audio_config {
            if current.asc == config
                && current.sample_rate == sample_rate
                && current.channels == channels
            {
                return Ok(());
            }
            return Err(anyhow!(
                "AAC configuration changed during an active MP4 recording"
            ));
        }
        let default_duration = (1_024_u64.saturating_mul(u64::from(TIMESCALE))
            / u64::from(sample_rate))
        .clamp(1, u64::from(u32::MAX)) as u32;
        self.audio_default_duration = default_duration;
        self.audio_last_duration = default_duration;
        self.audio_config = Some(AudioTrackConfig {
            asc: config.to_vec(),
            sample_rate,
            channels,
            bitrate,
        });
        Ok(())
    }

    pub fn set_avc_config(&mut self, config: &[u8]) -> Result<()> {
        validate_avc_config(config)?;
        if let Some(current) = &self.avc_config {
            if current == config {
                return Ok(());
            }
            return Err(anyhow!(
                "AVC configuration changed during an active MP4 recording"
            ));
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create recording directory {}", parent.display())
            })?;
        }
        let mut file = File::create(&self.path)
            .with_context(|| format!("failed to create recording {}", self.path.display()))?;
        file.write_all(&build_initialization_segment(
            config,
            self.width,
            self.height,
            self.default_duration,
        ))?;
        file.flush()?;
        self.file = Some(file);
        self.avc_config = Some(config.to_vec());
        Ok(())
    }

    pub fn write_sample(&mut self, pts_us: i64, keyframe: bool, data: &[u8]) -> Result<()> {
        if self.finalized {
            return Err(anyhow!("cannot append a sample after MP4 finalization"));
        }
        if self.file.is_none() {
            return Ok(());
        }
        validate_avcc_sample(data)?;
        if let Some(previous) = self.pending.take() {
            let duration = sample_duration(previous.pts_us, pts_us)?;
            self.write_fragment(previous, duration)?;
        }
        self.video_start_pts_us.get_or_insert(pts_us);
        self.pending = Some(PendingSample {
            pts_us,
            keyframe,
            data: data.to_vec(),
        });
        Ok(())
    }

    pub fn write_audio_sample(&mut self, pts_us: i64, data: &[u8]) -> Result<()> {
        if self.finalized {
            return Err(anyhow!("cannot append audio after MP4 finalization"));
        }
        if self.audio_config.is_none() || data.is_empty() {
            return Ok(());
        }
        if let Some(previous) = self.pending_audio.take() {
            let duration = sample_duration(previous.pts_us, pts_us)?;
            self.push_audio_sample(previous, duration)?;
        }
        self.audio_start_pts_us.get_or_insert(pts_us);
        self.pending_audio = Some(PendingAudioSample {
            pts_us,
            data: data.to_vec(),
        });
        Ok(())
    }

    pub fn finish(&mut self) -> Result<()> {
        if self.finalized {
            return Ok(());
        }
        if let Some(sample) = self.pending.take() {
            self.write_fragment(sample, self.last_duration)?;
        }
        if let Some(sample) = self.pending_audio.take() {
            self.push_audio_sample(sample, self.audio_last_duration)?;
        }
        if let Some(file) = &mut self.file {
            file.flush()?;
        }
        self.file.take();
        if !self.samples.is_empty() {
            let avc_config = self
                .avc_config
                .as_deref()
                .ok_or_else(|| anyhow!("missing AVC configuration while finalizing MP4"))?;
            finalize_regular_mp4(
                &self.path,
                avc_config,
                self.width,
                self.height,
                &self.samples,
                self.video_start_pts_us
                    .ok_or_else(|| anyhow!("missing first video PTS while finalizing MP4"))?,
                self.audio_config.as_ref(),
                &self.audio_samples,
                self.audio_start_pts_us,
            )?;
        }
        self.finalized = true;
        Ok(())
    }

    fn write_fragment(&mut self, sample: PendingSample, duration: u32) -> Result<()> {
        let Some(file) = &mut self.file else {
            return Ok(());
        };
        let sample_size = u32::try_from(sample.data.len())
            .map_err(|_| anyhow!("encoded video sample is too large for MP4"))?;
        let fragment = build_fragment(
            self.sequence,
            self.decode_time,
            duration,
            sample.keyframe,
            &sample.data,
        );
        let fragment_offset = file.stream_position()?;
        let sample_offset =
            fragment_offset.saturating_add(fragment.len().saturating_sub(sample.data.len()) as u64);
        file.write_all(&fragment)?;
        self.samples.push(WrittenSample {
            offset: sample_offset,
            size: sample_size,
            duration,
            keyframe: sample.keyframe,
        });
        if sample.keyframe {
            file.flush()?;
        }
        self.sequence = self.sequence.wrapping_add(1);
        self.decode_time = self.decode_time.saturating_add(u64::from(duration));
        self.last_duration = duration;
        Ok(())
    }

    fn push_audio_sample(&mut self, sample: PendingAudioSample, duration: u32) -> Result<()> {
        let size = u32::try_from(sample.data.len())
            .map_err(|_| anyhow!("encoded audio sample is too large for MP4"))?;
        self.audio_samples.push(WrittenAudioSample {
            size,
            duration,
            data: sample.data,
        });
        self.audio_last_duration = duration;
        Ok(())
    }
}

impl Drop for FragmentedMp4Recorder {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

fn sample_duration(previous_pts: i64, next_pts: i64) -> Result<u32> {
    let delta = next_pts
        .checked_sub(previous_pts)
        .ok_or_else(|| anyhow!("media PTS subtraction overflow"))?;
    if delta <= 0 {
        return Err(anyhow!(
            "media PTS is not strictly increasing: {previous_pts} -> {next_pts}"
        ));
    }
    u32::try_from(delta).map_err(|_| anyhow!("media sample duration exceeds MP4 timescale range"))
}

pub(crate) fn validate_avc_config(data: &[u8]) -> Result<()> {
    if data.len() < 7 || data[0] != 1 {
        return Err(anyhow!("invalid AVCDecoderConfigurationRecord"));
    }
    Ok(())
}

pub(crate) fn validate_avcc_sample(data: &[u8]) -> Result<()> {
    avcc_sample_contains_idr(data).map(|_| ())
}

pub(crate) fn avcc_sample_contains_idr(data: &[u8]) -> Result<bool> {
    let mut position = 0;
    let mut contains_idr = false;
    while position < data.len() {
        if data.len() - position < 4 {
            return Err(anyhow!("truncated AVCC NAL length"));
        }
        let length = u32::from_be_bytes(data[position..position + 4].try_into().unwrap()) as usize;
        position += 4;
        if length == 0 || position + length > data.len() {
            return Err(anyhow!("invalid AVCC NAL length"));
        }
        contains_idr |= data[position] & 0x1f == 5;
        position += length;
    }
    Ok(contains_idr)
}

fn build_initialization_segment(
    avc_config: &[u8],
    width: u16,
    height: u16,
    default_duration: u32,
) -> Vec<u8> {
    let mut output = build_ftyp();

    let mvhd = full_box(*b"mvhd", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 0);
        push_u32(&mut payload, TIMESCALE);
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 0x0001_0000);
        push_u16(&mut payload, 0x0100);
        push_u16(&mut payload, 0);
        payload.extend_from_slice(&[0; 8]);
        push_unity_matrix(&mut payload);
        payload.extend_from_slice(&[0; 24]);
        push_u32(&mut payload, 2);
        payload
    });

    let tkhd = full_box(*b"tkhd", 0, 0x000007, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 1);
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 0);
        payload.extend_from_slice(&[0; 8]);
        push_u16(&mut payload, 0);
        push_u16(&mut payload, 0);
        push_u16(&mut payload, 0);
        push_u16(&mut payload, 0);
        push_unity_matrix(&mut payload);
        push_u32(&mut payload, u32::from(width) << 16);
        push_u32(&mut payload, u32::from(height) << 16);
        payload
    });

    let mdhd = full_box(*b"mdhd", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 0);
        push_u32(&mut payload, TIMESCALE);
        push_u32(&mut payload, 0);
        push_u16(&mut payload, 0x55c4);
        push_u16(&mut payload, 0);
        payload
    });
    let hdlr = full_box(*b"hdlr", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 0);
        payload.extend_from_slice(b"vide");
        payload.extend_from_slice(&[0; 12]);
        payload.extend_from_slice(b"VideoHandler\0");
        payload
    });
    let vmhd = full_box(*b"vmhd", 0, 1, vec![0; 8]);
    let url = full_box(*b"url ", 0, 1, Vec::new());
    let dref = full_box(*b"dref", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        payload.extend_from_slice(&url);
        payload
    });
    let dinf = mp4_box(*b"dinf", dref);

    let avc1 = mp4_box(*b"avc1", {
        let mut payload = Vec::new();
        payload.extend_from_slice(&[0; 6]);
        push_u16(&mut payload, 1);
        payload.extend_from_slice(&[0; 16]);
        push_u16(&mut payload, width);
        push_u16(&mut payload, height);
        push_u32(&mut payload, 0x0048_0000);
        push_u32(&mut payload, 0x0048_0000);
        push_u32(&mut payload, 0);
        push_u16(&mut payload, 1);
        let mut compressor = [0_u8; 32];
        let name = b"LiveSuite H.264";
        compressor[0] = name.len() as u8;
        compressor[1..1 + name.len()].copy_from_slice(name);
        payload.extend_from_slice(&compressor);
        push_u16(&mut payload, 0x0018);
        push_u16(&mut payload, 0xffff);
        payload.extend_from_slice(&mp4_box(*b"avcC", avc_config.to_vec()));
        payload
    });
    let stsd = full_box(*b"stsd", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        payload.extend_from_slice(&avc1);
        payload
    });
    let stts = empty_table(*b"stts");
    let stsc = empty_table(*b"stsc");
    let stsz = full_box(*b"stsz", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 0);
        payload
    });
    let stco = empty_table(*b"stco");
    let stbl = mp4_box(*b"stbl", [stsd, stts, stsc, stsz, stco].concat());
    let minf = mp4_box(*b"minf", [vmhd, dinf, stbl].concat());
    let mdia = mp4_box(*b"mdia", [mdhd, hdlr, minf].concat());
    let trak = mp4_box(*b"trak", [tkhd, mdia].concat());

    let trex = full_box(*b"trex", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        push_u32(&mut payload, 1);
        push_u32(&mut payload, default_duration);
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 0x0001_0000);
        payload
    });
    let mvex = mp4_box(*b"mvex", trex);
    output.extend_from_slice(&mp4_box(*b"moov", [mvhd, trak, mvex].concat()));
    output
}

fn build_ftyp() -> Vec<u8> {
    mp4_box(*b"ftyp", {
        let mut payload = Vec::new();
        payload.extend_from_slice(b"isom");
        push_u32(&mut payload, 0x200);
        payload.extend_from_slice(b"isomiso6avc1mp41");
        payload
    })
}

fn finalize_regular_mp4(
    path: &PathBuf,
    avc_config: &[u8],
    width: u16,
    height: u16,
    samples: &[WrittenSample],
    video_start_pts_us: i64,
    audio_config: Option<&AudioTrackConfig>,
    audio_samples: &[WrittenAudioSample],
    audio_start_pts_us: Option<i64>,
) -> Result<()> {
    let temp_path = path.with_extension("mp4.finalizing");
    let backup_path = path.with_extension("mp4.fragmented");
    if backup_path.exists() {
        return Err(anyhow!(
            "refusing to overwrite unfinished MP4 backup {}",
            backup_path.display()
        ));
    }

    let write_result = (|| -> Result<()> {
        let audio_start_pts_us = audio_start_pts_us.filter(|_| !audio_samples.is_empty());
        let timeline_start_pts_us = video_start_pts_us;
        let video_start_offset = 0_u64;
        let audio_start_offset = match audio_start_pts_us {
            Some(audio_start) if audio_start > timeline_start_pts_us => u64::try_from(
                audio_start
                    .checked_sub(timeline_start_pts_us)
                    .ok_or_else(|| anyhow!("audio/timeline PTS subtraction overflow"))?,
            )
            .map_err(|_| anyhow!("invalid audio start offset"))?,
            _ => 0,
        };
        let mut source = File::open(path)
            .with_context(|| format!("failed to reopen recording {}", path.display()))?;
        let mut output = File::create(&temp_path).with_context(|| {
            format!(
                "failed to create finalized recording {}",
                temp_path.display()
            )
        })?;
        let ftyp = build_ftyp();
        let media_size = samples
            .iter()
            .try_fold(0_u64, |total, sample| {
                total.checked_add(u64::from(sample.size))
            })
            .ok_or_else(|| anyhow!("MP4 media size overflow"))?
            .checked_add(
                audio_samples
                    .iter()
                    .map(|sample| u64::from(sample.size))
                    .sum(),
            )
            .ok_or_else(|| anyhow!("MP4 media size overflow"))?;
        let mdat_header_size = if media_size <= u64::from(u32::MAX) - 8 {
            8_u64
        } else {
            16_u64
        };
        let placeholder_moov = build_regular_moov(
            avc_config,
            width,
            height,
            samples,
            0,
            video_start_offset,
            audio_config,
            audio_samples,
            0,
            audio_start_offset,
        )?;
        let video_chunk_offset = (ftyp.len() as u64)
            .saturating_add(placeholder_moov.len() as u64)
            .saturating_add(mdat_header_size);
        let audio_chunk_offset = video_chunk_offset.saturating_add(
            samples
                .iter()
                .map(|sample| u64::from(sample.size))
                .sum::<u64>(),
        );
        let moov = build_regular_moov(
            avc_config,
            width,
            height,
            samples,
            video_chunk_offset,
            video_start_offset,
            audio_config,
            audio_samples,
            audio_chunk_offset,
            audio_start_offset,
        )?;
        debug_assert_eq!(placeholder_moov.len(), moov.len());

        output.write_all(&ftyp)?;
        output.write_all(&moov)?;
        write_mdat_header(&mut output, media_size)?;
        for sample in samples {
            source.seek(SeekFrom::Start(sample.offset))?;
            let copied = std::io::copy(
                &mut Read::by_ref(&mut source).take(u64::from(sample.size)),
                &mut output,
            )?;
            if copied != u64::from(sample.size) {
                return Err(anyhow!("fragmented MP4 ended inside a video sample"));
            }
        }
        for sample in audio_samples {
            output.write_all(&sample.data)?;
        }
        output.flush()?;
        output.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    fs::rename(path, &backup_path)
        .with_context(|| format!("failed to preserve fragmented recording {}", path.display()))?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::rename(&backup_path, path);
        let _ = fs::remove_file(&temp_path);
        return Err(error)
            .with_context(|| format!("failed to install finalized recording {}", path.display()));
    }
    let _ = fs::remove_file(backup_path);
    Ok(())
}

fn write_mdat_header(output: &mut File, media_size: u64) -> Result<()> {
    if media_size <= u64::from(u32::MAX) - 8 {
        output.write_all(&((media_size as u32) + 8).to_be_bytes())?;
        output.write_all(b"mdat")?;
    } else {
        output.write_all(&1_u32.to_be_bytes())?;
        output.write_all(b"mdat")?;
        output.write_all(&media_size.saturating_add(16).to_be_bytes())?;
    }
    Ok(())
}

fn build_regular_moov(
    avc_config: &[u8],
    width: u16,
    height: u16,
    samples: &[WrittenSample],
    chunk_offset: u64,
    video_start_offset: u64,
    audio_config: Option<&AudioTrackConfig>,
    audio_samples: &[WrittenAudioSample],
    audio_chunk_offset: u64,
    audio_start_offset: u64,
) -> Result<Vec<u8>> {
    let sample_count =
        u32::try_from(samples.len()).map_err(|_| anyhow!("too many video samples for MP4"))?;
    let video_duration = samples.iter().try_fold(0_u64, |total, sample| {
        total
            .checked_add(u64::from(sample.duration))
            .ok_or_else(|| anyhow!("MP4 duration overflow"))
    })?;
    let audio_duration = audio_samples.iter().try_fold(0_u64, |total, sample| {
        total
            .checked_add(u64::from(sample.duration))
            .ok_or_else(|| anyhow!("MP4 audio duration overflow"))
    })?;
    let video_track_duration = video_start_offset
        .checked_add(video_duration)
        .ok_or_else(|| anyhow!("MP4 video track duration overflow"))?;
    let audio_track_duration = audio_start_offset
        .checked_add(audio_duration)
        .ok_or_else(|| anyhow!("MP4 audio track duration overflow"))?;
    let movie_duration = video_track_duration.max(audio_track_duration);

    let mvhd = full_box(*b"mvhd", 1, 0, {
        let mut payload = Vec::new();
        push_u64(&mut payload, 0);
        push_u64(&mut payload, 0);
        push_u32(&mut payload, TIMESCALE);
        push_u64(&mut payload, movie_duration);
        push_u32(&mut payload, 0x0001_0000);
        push_u16(&mut payload, 0x0100);
        push_u16(&mut payload, 0);
        payload.extend_from_slice(&[0; 8]);
        push_unity_matrix(&mut payload);
        payload.extend_from_slice(&[0; 24]);
        push_u32(&mut payload, if audio_config.is_some() { 3 } else { 2 });
        payload
    });
    let tkhd = full_box(*b"tkhd", 1, 0x000007, {
        let mut payload = Vec::new();
        push_u64(&mut payload, 0);
        push_u64(&mut payload, 0);
        push_u32(&mut payload, 1);
        push_u32(&mut payload, 0);
        push_u64(&mut payload, video_track_duration);
        payload.extend_from_slice(&[0; 8]);
        push_u16(&mut payload, 0);
        push_u16(&mut payload, 0);
        push_u16(&mut payload, 0);
        push_u16(&mut payload, 0);
        push_unity_matrix(&mut payload);
        push_u32(&mut payload, u32::from(width) << 16);
        push_u32(&mut payload, u32::from(height) << 16);
        payload
    });
    let mdhd = full_box(*b"mdhd", 1, 0, {
        let mut payload = Vec::new();
        push_u64(&mut payload, 0);
        push_u64(&mut payload, 0);
        push_u32(&mut payload, TIMESCALE);
        push_u64(&mut payload, video_duration);
        push_u16(&mut payload, 0x55c4);
        push_u16(&mut payload, 0);
        payload
    });
    let hdlr = full_box(*b"hdlr", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 0);
        payload.extend_from_slice(b"vide");
        payload.extend_from_slice(&[0; 12]);
        payload.extend_from_slice(b"VideoHandler\0");
        payload
    });
    let vmhd = full_box(*b"vmhd", 0, 1, vec![0; 8]);
    let url = full_box(*b"url ", 0, 1, Vec::new());
    let dref = full_box(*b"dref", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        payload.extend_from_slice(&url);
        payload
    });
    let dinf = mp4_box(*b"dinf", dref);

    let avc1 = mp4_box(*b"avc1", {
        let mut payload = Vec::new();
        payload.extend_from_slice(&[0; 6]);
        push_u16(&mut payload, 1);
        payload.extend_from_slice(&[0; 16]);
        push_u16(&mut payload, width);
        push_u16(&mut payload, height);
        push_u32(&mut payload, 0x0048_0000);
        push_u32(&mut payload, 0x0048_0000);
        push_u32(&mut payload, 0);
        push_u16(&mut payload, 1);
        let mut compressor = [0_u8; 32];
        let name = b"LiveSuite H.264";
        compressor[0] = name.len() as u8;
        compressor[1..1 + name.len()].copy_from_slice(name);
        payload.extend_from_slice(&compressor);
        push_u16(&mut payload, 0x0018);
        push_u16(&mut payload, 0xffff);
        payload.extend_from_slice(&mp4_box(*b"avcC", avc_config.to_vec()));
        payload
    });
    let stsd = full_box(*b"stsd", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        payload.extend_from_slice(&avc1);
        payload
    });
    let stts = full_box(*b"stts", 0, 0, {
        let mut runs = Vec::<(u32, u32)>::new();
        for sample in samples {
            match runs.last_mut() {
                Some((count, duration)) if *duration == sample.duration => {
                    *count = count.saturating_add(1);
                }
                _ => runs.push((1, sample.duration)),
            }
        }
        let mut payload = Vec::new();
        push_u32(&mut payload, runs.len().min(u32::MAX as usize) as u32);
        for (count, duration) in runs {
            push_u32(&mut payload, count);
            push_u32(&mut payload, duration);
        }
        payload
    });
    let stsc = full_box(*b"stsc", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        push_u32(&mut payload, 1);
        push_u32(&mut payload, sample_count);
        push_u32(&mut payload, 1);
        payload
    });
    let stsz = full_box(*b"stsz", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 0);
        push_u32(&mut payload, sample_count);
        for sample in samples {
            push_u32(&mut payload, sample.size);
        }
        payload
    });
    let co64 = full_box(*b"co64", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        push_u64(&mut payload, chunk_offset);
        payload
    });
    let stss = full_box(*b"stss", 0, 0, {
        let keyframes = samples
            .iter()
            .enumerate()
            .filter_map(|(index, sample)| sample.keyframe.then_some(index + 1))
            .collect::<Vec<_>>();
        let mut payload = Vec::new();
        push_u32(&mut payload, keyframes.len().min(u32::MAX as usize) as u32);
        for sample_number in keyframes {
            push_u32(&mut payload, sample_number as u32);
        }
        payload
    });
    let stbl = mp4_box(*b"stbl", [stsd, stts, stsc, stsz, co64, stss].concat());
    let minf = mp4_box(*b"minf", [vmhd, dinf, stbl].concat());
    let mdia = mp4_box(*b"mdia", [mdhd, hdlr, minf].concat());
    let mut video_track_contents = tkhd;
    if let Some(edit) = build_track_edit(video_start_offset, video_duration) {
        video_track_contents.extend_from_slice(&edit);
    }
    video_track_contents.extend_from_slice(&mdia);
    let trak = mp4_box(*b"trak", video_track_contents);
    let mut contents = [mvhd, trak].concat();
    if let Some(config) = audio_config.filter(|_| !audio_samples.is_empty()) {
        contents.extend_from_slice(&build_regular_audio_track(
            config,
            audio_samples,
            audio_chunk_offset,
            audio_duration,
            audio_start_offset,
        )?);
    }
    Ok(mp4_box(*b"moov", contents))
}

fn build_regular_audio_track(
    config: &AudioTrackConfig,
    samples: &[WrittenAudioSample],
    chunk_offset: u64,
    duration: u64,
    start_offset: u64,
) -> Result<Vec<u8>> {
    let sample_count =
        u32::try_from(samples.len()).map_err(|_| anyhow!("too many audio samples for MP4"))?;
    let tkhd = full_box(*b"tkhd", 1, 0x000007, {
        let mut payload = Vec::new();
        push_u64(&mut payload, 0);
        push_u64(&mut payload, 0);
        push_u32(&mut payload, 2);
        push_u32(&mut payload, 0);
        push_u64(
            &mut payload,
            start_offset
                .checked_add(duration)
                .ok_or_else(|| anyhow!("MP4 audio track duration overflow"))?,
        );
        payload.extend_from_slice(&[0; 8]);
        push_u16(&mut payload, 0);
        push_u16(&mut payload, 0);
        push_u16(&mut payload, 0x0100);
        push_u16(&mut payload, 0);
        push_unity_matrix(&mut payload);
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 0);
        payload
    });
    let mdhd = full_box(*b"mdhd", 1, 0, {
        let mut payload = Vec::new();
        push_u64(&mut payload, 0);
        push_u64(&mut payload, 0);
        push_u32(&mut payload, TIMESCALE);
        push_u64(&mut payload, duration);
        push_u16(&mut payload, 0x55c4);
        push_u16(&mut payload, 0);
        payload
    });
    let hdlr = full_box(*b"hdlr", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 0);
        payload.extend_from_slice(b"soun");
        payload.extend_from_slice(&[0; 12]);
        payload.extend_from_slice(b"SoundHandler\0");
        payload
    });
    let smhd = full_box(*b"smhd", 0, 0, vec![0; 4]);
    let url = full_box(*b"url ", 0, 1, Vec::new());
    let dref = full_box(*b"dref", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        payload.extend_from_slice(&url);
        payload
    });
    let dinf = mp4_box(*b"dinf", dref);

    let mp4a = mp4_box(*b"mp4a", {
        let mut payload = Vec::new();
        payload.extend_from_slice(&[0; 6]);
        push_u16(&mut payload, 1);
        payload.extend_from_slice(&[0; 8]);
        push_u16(&mut payload, u16::from(config.channels));
        push_u16(&mut payload, 16);
        push_u16(&mut payload, 0);
        push_u16(&mut payload, 0);
        push_u32(&mut payload, config.sample_rate << 16);
        payload.extend_from_slice(&build_esds(config));
        payload
    });
    let stsd = full_box(*b"stsd", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        payload.extend_from_slice(&mp4a);
        payload
    });
    let stts = full_box(*b"stts", 0, 0, {
        let mut runs = Vec::<(u32, u32)>::new();
        for sample in samples {
            match runs.last_mut() {
                Some((count, duration)) if *duration == sample.duration => {
                    *count = count.saturating_add(1);
                }
                _ => runs.push((1, sample.duration)),
            }
        }
        let mut payload = Vec::new();
        push_u32(&mut payload, runs.len().min(u32::MAX as usize) as u32);
        for (count, duration) in runs {
            push_u32(&mut payload, count);
            push_u32(&mut payload, duration);
        }
        payload
    });
    let stsc = full_box(*b"stsc", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        push_u32(&mut payload, 1);
        push_u32(&mut payload, sample_count);
        push_u32(&mut payload, 1);
        payload
    });
    let stsz = full_box(*b"stsz", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 0);
        push_u32(&mut payload, sample_count);
        for sample in samples {
            push_u32(&mut payload, sample.size);
        }
        payload
    });
    let co64 = full_box(*b"co64", 0, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 1);
        push_u64(&mut payload, chunk_offset);
        payload
    });
    let stbl = mp4_box(*b"stbl", [stsd, stts, stsc, stsz, co64].concat());
    let minf = mp4_box(*b"minf", [smhd, dinf, stbl].concat());
    let mdia = mp4_box(*b"mdia", [mdhd, hdlr, minf].concat());
    let mut contents = tkhd;
    if let Some(edit) = build_track_edit(start_offset, duration) {
        contents.extend_from_slice(&edit);
    }
    contents.extend_from_slice(&mdia);
    Ok(mp4_box(*b"trak", contents))
}

fn build_track_edit(start_offset: u64, duration: u64) -> Option<Vec<u8>> {
    if start_offset == 0 {
        return None;
    }
    let elst = full_box(*b"elst", 1, 0, {
        let mut payload = Vec::new();
        push_u32(&mut payload, 2);
        push_u64(&mut payload, start_offset);
        payload.extend_from_slice(&(-1_i64).to_be_bytes());
        push_u16(&mut payload, 1);
        push_u16(&mut payload, 0);
        push_u64(&mut payload, duration);
        payload.extend_from_slice(&0_i64.to_be_bytes());
        push_u16(&mut payload, 1);
        push_u16(&mut payload, 0);
        payload
    });
    Some(mp4_box(*b"edts", elst))
}

fn build_esds(config: &AudioTrackConfig) -> Vec<u8> {
    let decoder_specific = descriptor(0x05, config.asc.clone());
    let mut decoder_payload = Vec::new();
    decoder_payload.push(0x40);
    decoder_payload.push(0x15);
    decoder_payload.extend_from_slice(&[0, 0, 0]);
    push_u32(&mut decoder_payload, config.bitrate);
    push_u32(&mut decoder_payload, config.bitrate);
    decoder_payload.extend_from_slice(&decoder_specific);
    let decoder = descriptor(0x04, decoder_payload);
    let sl = descriptor(0x06, vec![0x02]);
    let mut es_payload = Vec::new();
    push_u16(&mut es_payload, 2);
    es_payload.push(0);
    es_payload.extend_from_slice(&decoder);
    es_payload.extend_from_slice(&sl);
    full_box(*b"esds", 0, 0, descriptor(0x03, es_payload))
}

fn descriptor(tag: u8, payload: Vec<u8>) -> Vec<u8> {
    let mut output = vec![tag];
    let length = payload.len().min(0x0fff_ffff);
    let mut encoded = [0_u8; 4];
    let mut value = length;
    for index in (0..4).rev() {
        encoded[index] = (value & 0x7f) as u8;
        value >>= 7;
    }
    let first = encoded.iter().position(|byte| *byte != 0).unwrap_or(3);
    for index in first..4 {
        let continuation = index != 3;
        output.push(encoded[index] | if continuation { 0x80 } else { 0 });
    }
    output.extend_from_slice(&payload);
    output
}

fn build_fragment(
    sequence: u32,
    decode_time: u64,
    duration: u32,
    keyframe: bool,
    sample: &[u8],
) -> Vec<u8> {
    let mfhd = full_box(*b"mfhd", 0, 0, sequence.to_be_bytes().to_vec());
    let tfhd = full_box(*b"tfhd", 0, 0x020000, 1_u32.to_be_bytes().to_vec());
    let tfdt = full_box(*b"tfdt", 1, 0, decode_time.to_be_bytes().to_vec());
    let sample_flags = if keyframe { 0x0200_0000 } else { 0x0101_0000 };
    let mut trun_payload = Vec::new();
    push_u32(&mut trun_payload, 1);
    push_u32(&mut trun_payload, 0);
    push_u32(&mut trun_payload, duration);
    push_u32(
        &mut trun_payload,
        sample.len().min(u32::MAX as usize) as u32,
    );
    push_u32(&mut trun_payload, sample_flags);
    let mut trun = full_box(*b"trun", 0, 0x000701, trun_payload);
    let traf = mp4_box(*b"traf", [tfhd, tfdt, trun.clone()].concat());
    let moof_size = 8 + mfhd.len() + traf.len();
    let data_offset = (moof_size + 8).min(i32::MAX as usize) as i32;
    let offset_position = 8 + 4 + 4;
    trun[offset_position..offset_position + 4].copy_from_slice(&data_offset.to_be_bytes());
    let traf = mp4_box(
        *b"traf",
        [
            full_box(*b"tfhd", 0, 0x020000, 1_u32.to_be_bytes().to_vec()),
            full_box(*b"tfdt", 1, 0, decode_time.to_be_bytes().to_vec()),
            trun,
        ]
        .concat(),
    );
    let mut output = mp4_box(*b"moof", [mfhd, traf].concat());
    output.extend_from_slice(&mp4_box(*b"mdat", sample.to_vec()));
    output
}

fn empty_table(name: [u8; 4]) -> Vec<u8> {
    full_box(name, 0, 0, 0_u32.to_be_bytes().to_vec())
}

fn full_box(name: [u8; 4], version: u8, flags: u32, payload: Vec<u8>) -> Vec<u8> {
    let mut contents = Vec::with_capacity(payload.len() + 4);
    contents.push(version);
    contents.extend_from_slice(&(flags & 0x00ff_ffff).to_be_bytes()[1..]);
    contents.extend_from_slice(&payload);
    mp4_box(name, contents)
}

fn mp4_box(name: [u8; 4], payload: Vec<u8>) -> Vec<u8> {
    let size = 8_usize.saturating_add(payload.len());
    let mut output = Vec::with_capacity(size);
    push_u32(&mut output, size.min(u32::MAX as usize) as u32);
    output.extend_from_slice(&name);
    output.extend_from_slice(&payload);
    output
}

fn push_unity_matrix(output: &mut Vec<u8>) {
    for value in [0x0001_0000_u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        push_u32(output, value);
    }
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn push_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::{
        avcc_sample_contains_idr, build_fragment, build_initialization_segment, sample_duration,
        FragmentedMp4Recorder,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const AVC_CONFIG: &[u8] = &[
        1, 100, 0, 31, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 1, 0x00, 0x02, 0x68, 0xee,
    ];
    const KEYFRAME: &[u8] = &[0, 0, 0, 2, 0x65, 0x88];
    const DELTA: &[u8] = &[0, 0, 0, 2, 0x41, 0x9a];

    #[test]
    fn initialization_segment_contains_required_boxes() {
        let data = build_initialization_segment(AVC_CONFIG, 1920, 1080, 33_333);
        assert_eq!(&data[4..8], b"ftyp");
        assert!(data.windows(4).any(|window| window == b"moov"));
        assert!(data.windows(4).any(|window| window == b"avcC"));
        assert!(data.windows(4).any(|window| window == b"mvex"));
    }

    #[test]
    fn fragment_points_trun_at_mdat_payload() {
        let data = build_fragment(1, 0, 33_333, true, KEYFRAME);
        assert_eq!(&data[4..8], b"moof");
        let trun = data
            .windows(4)
            .position(|window| window == b"trun")
            .unwrap()
            - 4;
        let data_offset = i32::from_be_bytes(data[trun + 16..trun + 20].try_into().unwrap());
        let moof_size = u32::from_be_bytes(data[0..4].try_into().unwrap()) as i32;
        assert_eq!(data_offset, moof_size + 8);
        assert_eq!(
            &data[moof_size as usize + 4..moof_size as usize + 8],
            b"mdat"
        );
    }

    #[test]
    fn recorder_finalizes_as_fast_start_regular_mp4() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("livesuite-mp4-{suffix}"));
        let path = directory.join("test.mp4");
        let mut recorder = FragmentedMp4Recorder::new(path.clone(), 1920, 1080, 30, false);
        recorder.set_avc_config(AVC_CONFIG).unwrap();
        recorder.write_sample(0, true, KEYFRAME).unwrap();
        recorder.write_sample(33_333, false, DELTA).unwrap();
        recorder.finish().unwrap();
        drop(recorder);

        let data = fs::read(&path).unwrap();
        assert_eq!(
            data.windows(4).filter(|window| *window == b"moof").count(),
            0
        );
        assert_eq!(
            data.windows(4).filter(|window| *window == b"mdat").count(),
            1
        );
        let moov = data
            .windows(4)
            .position(|window| window == b"moov")
            .unwrap();
        let mdat = data
            .windows(4)
            .position(|window| window == b"mdat")
            .unwrap();
        assert!(moov < mdat);
        assert!(data.windows(4).any(|window| window == b"stts"));
        assert!(data.windows(4).any(|window| window == b"stss"));
        assert!(data.windows(4).any(|window| window == b"co64"));
        assert!(data
            .windows(KEYFRAME.len())
            .any(|window| window == KEYFRAME));
        assert!(data.windows(DELTA.len()).any(|window| window == DELTA));
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn recorder_finalizes_with_aac_audio_track() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("livesuite-av-mp4-{suffix}"));
        let path = directory.join("test-av.mp4");
        let audio = [0xde, 0xad, 0xbe, 0xef];
        let mut recorder = FragmentedMp4Recorder::new(path.clone(), 1920, 1080, 30, true);
        recorder.set_avc_config(AVC_CONFIG).unwrap();
        recorder
            .set_aac_config(&[0x11, 0x90], 48_000, 2, 128_000)
            .unwrap();
        recorder.write_sample(0, true, KEYFRAME).unwrap();
        recorder.write_sample(33_333, false, DELTA).unwrap();
        recorder.write_audio_sample(0, &audio).unwrap();
        recorder.write_audio_sample(21_333, &audio).unwrap();
        recorder.finish().unwrap();
        drop(recorder);

        let data = fs::read(&path).unwrap();
        assert_eq!(
            data.windows(4).filter(|window| *window == b"trak").count(),
            2
        );
        assert!(data.windows(4).any(|window| window == b"mp4a"));
        assert!(data.windows(4).any(|window| window == b"esds"));
        assert!(data.windows(audio.len()).any(|window| window == audio));
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn recorder_preserves_audio_start_offset_from_source_pts() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("livesuite-av-offset-{suffix}"));
        let path = directory.join("test-av-offset.mp4");
        let audio = [0xde, 0xad, 0xbe, 0xef];
        let mut recorder = FragmentedMp4Recorder::new(path.clone(), 1920, 1080, 30, true);
        recorder.set_avc_config(AVC_CONFIG).unwrap();
        recorder
            .set_aac_config(&[0x11, 0x90], 48_000, 2, 128_000)
            .unwrap();
        recorder.write_sample(1_000_000, true, KEYFRAME).unwrap();
        recorder.write_sample(1_033_333, false, DELTA).unwrap();
        recorder.write_audio_sample(1_125_000, &audio).unwrap();
        recorder.write_audio_sample(1_146_333, &audio).unwrap();
        recorder.finish().unwrap();
        drop(recorder);

        let data = fs::read(&path).unwrap();
        assert!(data.windows(4).any(|window| window == b"edts"));
        assert!(data.windows(4).any(|window| window == b"elst"));
        assert!(data
            .windows(8)
            .any(|window| window == 125_000_u64.to_be_bytes()));
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn recorder_anchors_timeline_to_video_start_when_audio_begins_first() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("livesuite-video-offset-{suffix}"));
        let path = directory.join("test-video-offset.mp4");
        let audio = [0xde, 0xad, 0xbe, 0xef];
        let mut recorder = FragmentedMp4Recorder::new(path.clone(), 1920, 1080, 30, true);
        recorder.set_avc_config(AVC_CONFIG).unwrap();
        recorder
            .set_aac_config(&[0x11, 0x90], 48_000, 2, 128_000)
            .unwrap();
        recorder.write_audio_sample(900_000, &audio).unwrap();
        recorder.write_audio_sample(921_333, &audio).unwrap();
        recorder.write_sample(1_000_000, true, KEYFRAME).unwrap();
        recorder.write_sample(1_033_333, false, DELTA).unwrap();
        recorder.finish().unwrap();
        drop(recorder);

        let data = fs::read(&path).unwrap();
        // Video track starts at 0 offset, audio starts aligned without video empty edit list
        assert!(data.windows(4).any(|window| window == b"mp4a"));
        assert!(data.windows(4).any(|window| window == b"avc1"));
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn sample_duration_preserves_source_pts_and_rejects_regressions() {
        assert!(sample_duration(100, 99).is_err());
        assert!(sample_duration(100, 100).is_err());
        assert_eq!(sample_duration(100, 133).unwrap(), 33);
        assert_eq!(sample_duration(100, 66_766).unwrap(), 66_666);
    }

    #[test]
    fn random_access_is_determined_from_idr_nal_units() {
        assert!(avcc_sample_contains_idr(KEYFRAME).unwrap());
        assert!(!avcc_sample_contains_idr(DELTA).unwrap());
        assert!(
            avcc_sample_contains_idr(&[0, 0, 0, 2, 0x06, 0x01, 0, 0, 0, 2, 0x65, 0x88,]).unwrap()
        );
    }
}
