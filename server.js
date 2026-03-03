// PromptPilot Backend
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    if (!GEMINI_KEY) return reject(new Error('GEMINI_API_KEY not set on server'));
    const sp = `You are an expert prompt engineer. Improve the following prompt to be clearer, more specific, and more likely to get an excellent AI response.\n\nRules:\n- Keep the same intent and goal\n- Make it more specific and detailed\n- Add context if helpful\n- Use clear structure if complex\n- Do NOT over-engineer simple prompts\n- Return ONLY the improved prompt, nothing else.\n\nOriginal prompt:\n${prompt}`;
    const body = JSON.stringify({ contents:[{parts:[{text:sp}]}], generationConfig:{maxOutputTokens:1000,temperature:0.7} });
    const req = https.request({
      hostname:'generativelanguage.googleapis.com',
      path:`/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    }, (res) => {
      let d='';
      res.on('data',c=>d+=c);
      res.on('end',()=>{
        try {
          const p=JSON.parse(d);
          if(res.statusCode===429) return reject(new Error('Server busy. Try again.'));
          if(res.statusCode!==200) return reject(new Error(p.error?.message||'API error'));
          const t=p.candidates?.[0]?.content?.parts?.[0]?.text;
          if(!t) return reject(new Error('Empty response'));
          resolve(t.trim());
        } catch(e){reject(new Error('Parse error'));}
      });
    });
    req.on('error',reject);
    req.write(body);
    req.end();
  });
}

http.createServer(async(req,res)=>{
  Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v));
  if(req.method==='OPTIONS'){res.writeHead(200);return res.end();}
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200);return res.end(JSON.stringify({status:'PromptPilot backend is live',version:'1.0.0'}));}
  if(req.method==='POST'&&req.url==='/improve'){
    let b='';
    req.on('data',c=>b+=c);
    req.on('end',async()=>{
      try{
        const {prompt}=JSON.parse(b);
        if(!prompt||typeof prompt!=='string'){res.writeHead(400);return res.end(JSON.stringify({error:'prompt required'}));}
        if(prompt.trim().length<3){res.writeHead(400);return res.end(JSON.stringify({error:'Too short'}));}
        const improved=await callGemini(prompt.trim());
        res.writeHead(200);
        res.end(JSON.stringify({success:true,improved}));
      }catch(err){
        console.error(err.message);
        res.writeHead(500);
        res.end(JSON.stringify({error:err.message||'Error'}));
      }
    });
    return;
  }
  res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
}).listen(PORT,()=>console.log(`PromptPilot running on port ${PORT}`));
