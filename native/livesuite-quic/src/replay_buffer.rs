use std::collections::VecDeque;
use std::sync::Arc;

const MAX_REPLAY_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ReplaySample {
    pub pts_us: i64,
    pub kind: ReplaySampleKind,
    pub data: Arc<[u8]>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplaySampleKind {
    Video { keyframe: bool },
    Audio,
}

impl ReplaySample {
    pub fn is_keyframe(&self) -> bool {
        matches!(self.kind, ReplaySampleKind::Video { keyframe: true })
    }
}

#[derive(Clone, Debug)]
pub struct ReplaySnapshot {
    pub avc_config: Vec<u8>,
    pub aac_config: Option<Vec<u8>>,
    pub expects_audio: bool,
    pub audio_sample_rate: u32,
    pub audio_channels: u8,
    pub audio_bitrate: u32,
    pub samples: Vec<ReplaySample>,
}

#[derive(Debug)]
pub struct ReplayBuffer {
    duration_us: i64,
    avc_config: Option<Vec<u8>>,
    aac_config: Option<Vec<u8>>,
    expects_audio: bool,
    audio_sample_rate: u32,
    audio_channels: u8,
    audio_bitrate: u32,
    samples: VecDeque<ReplaySample>,
    bytes: usize,
}

impl ReplayBuffer {
    pub fn new(
        duration_ms: u64,
        avc_config: Option<&[u8]>,
        aac_config: Option<&[u8]>,
        expects_audio: bool,
        audio_sample_rate: u32,
        audio_channels: u8,
        audio_bitrate: u32,
    ) -> Self {
        Self {
            duration_us: duration_ms.saturating_mul(1000).min(i64::MAX as u64) as i64,
            avc_config: avc_config.map(ToOwned::to_owned),
            aac_config: aac_config.map(ToOwned::to_owned),
            expects_audio,
            audio_sample_rate,
            audio_channels,
            audio_bitrate,
            samples: VecDeque::new(),
            bytes: 0,
        }
    }

    pub fn set_aac_config(&mut self, config: &[u8]) {
        if self.aac_config.as_deref() != Some(config) {
            self.samples.clear();
            self.bytes = 0;
            self.aac_config = Some(config.to_vec());
        }
    }

    pub fn set_avc_config(&mut self, config: &[u8]) {
        if self.avc_config.as_deref() != Some(config) {
            self.samples.clear();
            self.bytes = 0;
            self.avc_config = Some(config.to_vec());
        }
    }

    pub fn push(&mut self, pts_us: i64, keyframe: bool, data: &[u8]) {
        if !keyframe && !self.samples.iter().any(ReplaySample::is_keyframe) {
            return;
        }
        self.bytes = self.bytes.saturating_add(data.len());
        self.samples.push_back(ReplaySample {
            pts_us,
            kind: ReplaySampleKind::Video { keyframe },
            data: Arc::from(data),
        });
        self.trim();
    }

    pub fn push_audio(&mut self, pts_us: i64, data: &[u8]) {
        if self.aac_config.is_none() || !self.samples.iter().any(ReplaySample::is_keyframe) {
            return;
        }
        self.bytes = self.bytes.saturating_add(data.len());
        self.samples.push_back(ReplaySample {
            pts_us,
            kind: ReplaySampleKind::Audio,
            data: Arc::from(data),
        });
        self.trim();
    }

    pub fn snapshot(&self) -> Option<ReplaySnapshot> {
        let avc_config = self.avc_config.clone()?;
        let first_keyframe_pts = self
            .samples
            .iter()
            .find_map(|sample| sample.is_keyframe().then_some(sample.pts_us))?;
        if self.expects_audio && self.aac_config.is_none() {
            return None;
        }
        Some(ReplaySnapshot {
            avc_config,
            aac_config: self.aac_config.clone(),
            expects_audio: self.expects_audio,
            audio_sample_rate: self.audio_sample_rate,
            audio_channels: self.audio_channels,
            audio_bitrate: self.audio_bitrate,
            samples: {
                let mut samples = self
                    .samples
                    .iter()
                    .filter(|sample| sample.pts_us >= first_keyframe_pts)
                    .cloned()
                    .collect::<Vec<_>>();
                samples.sort_by_key(|sample| sample.pts_us);
                samples
            },
        })
    }

    pub fn duration_ms(&self) -> u64 {
        self.duration_us.max(0) as u64 / 1000
    }

    fn trim(&mut self) {
        let Some(latest_pts) = self.samples.iter().map(|sample| sample.pts_us).max() else {
            return;
        };
        let cutoff = latest_pts.saturating_sub(self.duration_us);

        // Audio does not need a random-access boundary. Evict it at the exact
        // configured time window even when the video GOP is unusually long.
        // Video may retain one older keyframe so the exported window remains
        // decodable, but that must not accidentally retain minutes of audio.
        let mut retained_bytes = 0_usize;
        self.samples.retain(|sample| {
            let keep = !matches!(sample.kind, ReplaySampleKind::Audio) || sample.pts_us >= cutoff;
            if keep {
                retained_bytes = retained_bytes.saturating_add(sample.data.len());
            }
            keep
        });
        self.bytes = retained_bytes;

        loop {
            let keyframes = self
                .samples
                .iter()
                .enumerate()
                .filter_map(|(index, sample)| {
                    sample.is_keyframe().then_some((index, sample.pts_us))
                })
                .collect::<Vec<_>>();
            let Some(&(_, next_keyframe_pts)) = keyframes.get(1) else {
                break;
            };
            if next_keyframe_pts > cutoff && self.bytes <= MAX_REPLAY_BYTES {
                break;
            }
            let mut retained_bytes = 0_usize;
            self.samples.retain(|sample| {
                let keep = sample.pts_us >= next_keyframe_pts;
                if keep {
                    retained_bytes = retained_bytes.saturating_add(sample.data.len());
                }
                keep
            });
            self.bytes = retained_bytes;
        }
        // A malformed stream with an extremely large GOP must not grow without
        // bound. Clearing it makes the buffer wait for the next keyframe.
        if self.bytes > MAX_REPLAY_BYTES {
            self.samples.clear();
            self.bytes = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ReplayBuffer;

    #[test]
    fn replay_waits_for_a_keyframe() {
        let mut replay = ReplayBuffer::new(30_000, Some(&[1, 2, 3]), None, false, 0, 0, 0);
        replay.push(0, false, &[1]);
        assert!(replay.snapshot().is_none());
        replay.push(1_000, true, &[2]);
        replay.push(2_000, false, &[3]);
        let snapshot = replay.snapshot().unwrap();
        assert_eq!(snapshot.samples.len(), 2);
        assert!(snapshot.samples[0].is_keyframe());
    }

    #[test]
    fn replay_trims_only_at_keyframe_boundaries() {
        let mut replay = ReplayBuffer::new(1_000, Some(&[1]), None, false, 0, 0, 0);
        replay.push(0, true, &[1]);
        replay.push(500_000, false, &[2]);
        replay.push(1_000_000, true, &[3]);
        replay.push(1_500_000, false, &[4]);
        replay.push(2_100_000, true, &[5]);
        let snapshot = replay.snapshot().unwrap();
        assert_eq!(snapshot.samples[0].pts_us, 1_000_000);
        assert!(snapshot.samples[0].is_keyframe());
    }

    #[test]
    fn configuration_change_discards_old_samples() {
        let mut replay = ReplayBuffer::new(30_000, Some(&[1]), None, false, 0, 0, 0);
        replay.push(0, true, &[1]);
        replay.set_avc_config(&[2]);
        assert!(replay.snapshot().is_none());
    }

    #[test]
    fn audio_is_retained_after_the_video_keyframe() {
        let mut replay = ReplayBuffer::new(
            30_000,
            Some(&[1]),
            Some(&[0x11, 0x90]),
            true,
            48_000,
            2,
            128_000,
        );
        replay.push(1_000, true, &[2]);
        replay.push_audio(1_500, &[3]);
        let snapshot = replay.snapshot().unwrap();
        assert_eq!(snapshot.samples.len(), 2);
        assert_eq!(
            snapshot.aac_config.as_deref(),
            Some([0x11, 0x90].as_slice())
        );
    }

    #[test]
    fn audio_samples_after_the_keyframe_are_sorted_and_exported() {
        let mut replay = ReplayBuffer::new(
            30_000,
            Some(&[1]),
            Some(&[0x11, 0x90]),
            true,
            48_000,
            2,
            128_000,
        );
        replay.push(1_000, true, &[1]);
        replay.push_audio(1_050, &[2]);
        replay.push_audio(1_100, &[3]);

        let snapshot = replay.snapshot().unwrap();
        assert_eq!(snapshot.samples.len(), 3);
        assert_eq!(snapshot.samples[0].pts_us, 1_000);
        assert_eq!(snapshot.samples[1].pts_us, 1_050);
        assert_eq!(snapshot.samples[2].pts_us, 1_100);
    }

    #[test]
    fn trimming_removes_audio_older_than_the_new_keyframe() {
        let mut replay = ReplayBuffer::new(
            1_000,
            Some(&[1]),
            Some(&[0x11, 0x90]),
            true,
            48_000,
            2,
            128_000,
        );
        replay.push(0, true, &[1]);
        replay.push(1_000_000, true, &[2]);
        replay.push_audio(900_000, &[3]);
        replay.push(2_100_000, true, &[4]);

        let snapshot = replay.snapshot().unwrap();
        assert_eq!(snapshot.samples[0].pts_us, 1_000_000);
        assert!(snapshot
            .samples
            .iter()
            .all(|sample| sample.pts_us >= 1_000_000));
    }

    #[test]
    fn long_gop_does_not_extend_the_audio_cache_window() {
        let mut replay = ReplayBuffer::new(
            1_000,
            Some(&[1]),
            Some(&[0x11, 0x90]),
            true,
            48_000,
            2,
            128_000,
        );
        replay.push(0, true, &[1]);
        replay.push_audio(0, &[2]);
        replay.push_audio(1_000_000, &[3]);
        replay.push_audio(2_000_000, &[4]);

        let snapshot = replay.snapshot().unwrap();
        assert!(snapshot.samples[0].is_keyframe());
        assert!(snapshot
            .samples
            .iter()
            .filter(|sample| matches!(sample.kind, super::ReplaySampleKind::Audio))
            .all(|sample| sample.pts_us >= 1_000_000));
    }
}
