// Minimal HTTP server used by run-tests.js to exercise the `server` config
// option (auto-start/wait/stop a dev server around the audit). Not part of
// the published package — test-only.
'use strict';
const http = require('http');

const port = process.argv[2];

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Mini Server Fixture</title></head>
<body>
  <header><h1>Hello from the mini server</h1></header>
  <main><p>Some perfectly fine, high-contrast text.</p></main>
</body>
</html>`;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  })
  .listen(port, '127.0.0.1');
