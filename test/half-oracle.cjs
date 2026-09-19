const assert=require('node:assert/strict'),Q=require('../fi-quality.js'),data=require('./fixtures/half-oracle.json');
const u=new Uint32Array(1),f=new Float32Array(u.buffer);
for(const [bits,half] of data){u[0]=bits;assert.equal(Q.floatToHalf(f[0]),half,'float32 bits '+bits);}
console.log(`PASS: ${data.length} independent NumPy float32 -> binary16 oracle cases`);
