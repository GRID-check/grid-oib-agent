import sharp from 'sharp'
const [,, f, left, top, w, h, out, outw] = process.argv
await sharp(f).extract({ left: +left, top: +top, width: +w, height: +h }).resize({ width: +outw }).toFile(out)
console.log('ok')
