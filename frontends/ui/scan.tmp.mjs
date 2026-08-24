import sharp from 'sharp'
const f = process.argv[2]
const target = process.argv[3].split(',').map(Number) // r,g,b
const tol = Number(process.argv[4] ?? 24)
const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true })
const { width, height, channels } = info
const rows = []
for (let y = 0; y < height; y += 2) {
  let count = 0
  for (let x = 0; x < width; x += 3) {
    const i = (y * width + x) * channels
    if (Math.abs(data[i]-target[0])<tol && Math.abs(data[i+1]-target[1])<tol && Math.abs(data[i+2]-target[2])<tol) count++
  }
  if (count > 3) rows.push([y, count])
}
console.log(JSON.stringify(rows.slice(0, 5)), '...', JSON.stringify(rows.slice(-5)), 'n=', rows.length)
