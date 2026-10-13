export function messageParts(text){
  const parts=[];let rest=text;
  while(rest.length>3500){let cut=rest.lastIndexOf('\n',3500);if(cut<1750)cut=3500;else cut++;
    if(/[\uD800-\uDBFF]/.test(rest[cut-1]))cut--;parts.push(rest.slice(0,cut));rest=rest.slice(cut);}
  if(rest)parts.push(rest);return parts;
}
