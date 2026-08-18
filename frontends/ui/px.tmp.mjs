import sharp from 'sharp'
const [,,f,x,y,w,h]=process.argv
const {data,info}=await sharp(f).extract({left:+x,top:+y,width:+w,height:+h}).raw().toBuffer({resolveWithObject:true})
const counts=new Map()
for(let i=0;i<data.length;i+=info.channels){
  const k=`${data[i]},${data[i+1]},${data[i+2]}`
  counts.set(k,(counts.get(k)||0)+1)
}
console.log([...counts].sort((a,b)=>b[1]-a[1]).slice(0,6))
