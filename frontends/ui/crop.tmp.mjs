import sharp from 'sharp'
const [,, f, top, height, out, w] = process.argv
await sharp(f).extract({ left: 0, top: Number(top), width: (await sharp(f).metadata()).width, height: Number(height) })
  .resize({ width: Number(w ?? 1000) }).toFile(out)
console.log('wrote', out)
