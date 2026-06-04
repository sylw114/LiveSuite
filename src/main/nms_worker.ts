import NodeMediaServer from 'node-media-server';

process.on('message', (message: any) => {
  if (message.type === 'start') {
    const rtmpServer = new NodeMediaServer({
      rtmp: {
        port: parseInt(message.port),
        chunk_size: 30000,
        gop_cache: false,
        ping: 30,
        ping_timeout: 60
      }
    });

    // The node-media-server doesn't expose the underlying net.Server via an 'error' event on the class instance,
    // but the error will crash the process if not handled globally.
    // We can try to bind the port ourselves first to check if it's available.
    const net = require('net');
    const tester = net.createServer();
    tester.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        throw new Error('port is already in use, pls use another one');
      } else {
        throw err;
      }
    });
    tester.once('listening', () => {
      tester.close(() => {
        rtmpServer.run();
        process.send?.({ type: 'started' });
      });
    });
    tester.listen(parseInt(message.port));
  }
});
