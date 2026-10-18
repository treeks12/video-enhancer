'use strict';
const comparison=document.getElementById('comparison');
const range=document.getElementById('comparison-range');
range.addEventListener('input',()=>comparison.style.setProperty('--split',range.value+'%'));
const examples={
 spiderman:['Spider-Man: Across the Spider-Verse','https://www.sonypictures.com/movies/spidermanacrossthespiderverse'],
 avengers:['Avengers: Endgame','https://movies.disney.com/avengers-endgame/'],
 fortnite:['Fortnite','https://www.youtube.com/watch?v=2gUtfBmw86Y'],
 forza:['Forza Horizon 5','https://store.steampowered.com/app/1551360/'],
 counterstrike:['Counter-Strike 2','https://store.steampowered.com/app/730/'],
 mrbeast:['MrBeast','https://www.youtube.com/watch?v=0e3GPea1Tyg']
};
let generation=0;
for(const button of document.querySelectorAll('[data-example]'))button.addEventListener('click',async()=>{
 const id=button.dataset.example,serial=++generation,[name,source]=examples[id];
 const images=await Promise.all(['before','after'].map(async side=>{const image=new Image();image.src='assets/'+id+'-'+side+'.webp';await image.decode();return image;})).catch(()=>null);
 if(!images||serial!==generation)return;
 const original=document.getElementById('original-image'),enhanced=document.getElementById('enhanced-image');
 original.src=images[0].src;enhanced.src=images[1].src;original.alt='Original '+name+' demo';enhanced.alt='Enhanced '+name+' demo';
 document.getElementById('sample-source').href=source;
 for(const control of document.querySelectorAll('[data-example]'))control.setAttribute('aria-pressed',String(control===button));
});
