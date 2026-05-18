const fs   = require('fs');
const zlib = require('zlib');

function makePNG(size, outPath) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t   = Buffer.from(type);
    const crc = crc32(Buffer.concat([t, data]));
    const c   = Buffer.alloc(4); c.writeUInt32BE(crc >>> 0);
    return Buffer.concat([len, t, data, c]);
  }

  function crc32(buf) {
    const t = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  // Build raw pixel rows
  const rows = [];
  const cx = size / 2, cy = size / 2, r = size * 0.42;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte + RGB
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const inCircle = dx*dx + dy*dy <= r*r;
      let R, G, B;
      if (inCircle) {
        // green circle background
        R = 35; G = 134; B = 54;
        // chart line (approximate with thick line segments)
        const pts = [[0.25,0.6],[0.42,0.45],[0.58,0.55],[0.75,0.35]];
        const lw  = size * 0.06;
        let onLine = false;
        for (let i = 0; i < pts.length - 1; i++) {
          const x1=pts[i][0]*size, y1=pts[i][1]*size, x2=pts[i+1][0]*size, y2=pts[i+1][1]*size;
          const lenSq = (x2-x1)**2 + (y2-y1)**2;
          if (lenSq === 0) continue;
          const t = Math.max(0, Math.min(1, ((x-x1)*(x2-x1)+(y-y1)*(y2-y1))/lenSq));
          const dist = Math.sqrt((x-(x1+t*(x2-x1)))**2 + (y-(y1+t*(y2-y1)))**2);
          if (dist < lw/2) { onLine = true; break; }
        }
        if (onLine) { R = 255; G = 255; B = 255; }
      } else {
        R = 13; G = 17; B = 23; // dark bg
      }
      const off = 1 + x * 3;
      row[off] = R; row[off+1] = G; row[off+2] = B;
    }
    rows.push(row);
  }

  const raw  = Buffer.concat(rows);
  const idat = zlib.deflateSync(raw, { level: 6 });

  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(outPath, png);
  console.log('wrote', outPath, `(${size}x${size})`);
}

makePNG(192, 'public/icon-192.png');
makePNG(512, 'public/icon-512.png');
