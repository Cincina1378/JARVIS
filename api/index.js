
const OPENAI_URL = "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

function send(res,status,data){
 res.status(status).json(data);
}

async function redis(command){
 const url=process.env.UPSTASH_REDIS_REST_URL;
 const token=process.env.UPSTASH_REDIS_REST_TOKEN;
 if(!url||!token)return null;

 const r=await fetch(url,{
  method:"POST",
  headers:{
   Authorization:"Bearer "+token,
   "Content-Type":"application/json"
  },
  body:JSON.stringify(command)
 });

 if(!r.ok)throw Error("Upstash bağlantı hatası.");
 const j=await r.json();
 return j.result;
}

export default async function handler(req,res){
 if(req.method!=="POST")return send(res,405,{error:"POST gerekli."});

 if(!process.env.OPENAI_API_KEY){
  return send(res,500,{error:"OPENAI_API_KEY eksik."});
 }

 try{
  const action=new URL(req.url,"https://local.invalid").searchParams.get("action");

  if(action==="transcribe"){
   const chunks=[];
   for await(const chunk of req)chunks.push(chunk);
   const raw=Buffer.concat(chunks);

   const boundary=(req.headers["content-type"]||"").match(/boundary=(?:"([^"]+)"|([^;]+))/);
   const b=boundary?.[1]||boundary?.[2];
   if(!b)return send(res,400,{error:"Ses dosyası bulunamadı."});

   const body=raw.toString("binary");
   const parts=body.split("--"+b);
   let audio=null,mime="audio/mp4",filename="voice.m4a";

   for(const part of parts){
    if(!part.includes('name="audio"'))continue;
    const i=part.indexOf("\r\n\r\n");
    if(i<0)continue;

    const head=part.slice(0,i);
    filename=head.match(/filename="([^"]+)"/)?.[1]||filename;
    mime=head.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]||mime;
    audio=Buffer.from(part.slice(i+4).replace(/\r\n$/,""),"binary");
    break;
   }

   if(!audio)return send(res,400,{error:"Ses verisi boş."});

   const form=new FormData();
   form.append("file",new Blob([audio],{type:mime}),filename);
   form.append("model","gpt-4o-mini-transcribe");
   form.append("language","tr");

   const r=await fetch(OPENAI_URL+"/audio/transcriptions",{
    method:"POST",
    headers:{Authorization:"Bearer "+process.env.OPENAI_API_KEY},
    body:form
   });

   const j=await r.json();
   if(!r.ok)return send(res,r.status,{error:j.error?.message||"Transkripsiyon hatası."});
   return send(res,200,{text:j.text||""});
  }

  const {clientId,messages}=req.body||{};
  if(!Array.isArray(messages)||!messages.length){
   return send(res,400,{error:"Mesaj bulunamadı."});
  }

  const safeId=String(clientId||"guest").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,64);
  const key="jarvis:"+safeId+":memory";

  let old=[];
  try{
   const saved=await redis(["GET",key]);
   if(saved)old=JSON.parse(saved);
  }catch(e){}

  const history=[...old,...messages].slice(-18);

  const input=history.map(m=>({
   role:m.role==="assistant"?"assistant":"user",
   content:String(m.content||"").slice(0,5000)
  }));

  const r=await fetch(OPENAI_URL+"/responses",{
   method:"POST",
   headers:{
    Authorization:"Bearer "+process.env.OPENAI_API_KEY,
    "Content-Type":"application/json"
   },
   body:JSON.stringify({
    model:MODEL,
    instructions:"Sen JARVIS adlı Türkçe kişisel asistansın. Filmdeki JARVIS gibi sakin, profesyonel ve kısa konuş. Yapmadığın işlemi yaptığını söyleme. Kullanıcıya Türkçe cevap ver.",
    input
   })
  });

  const j=await r.json();
  if(!r.ok)return send(res,r.status,{error:j.error?.message||"OpenAI hatası."});

  const reply=j.output_text||j.output?.flatMap(x=>x.content||[]).find(x=>x.type==="output_text")?.text||"Yanıt oluşturulamadı.";

  try{
   await redis(["SET",key,JSON.stringify([...history,{role:"assistant",content:reply}].slice(-24))]);
  }catch(e){}

  return send(res,200,{reply});

 }catch(e){
  return send(res,500,{error:e.message||"Sunucu hatası."});
 }
}
