
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "JARVIS API" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Yalnızca POST destekleniyor." });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY Vercel ayarlarında bulunamadı." });
  }

  const action = req.query?.action;

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : (req.body || {});

    // SESİ YAZIYA ÇEVİR
    if (action === "transcribe") {
      if (!body.audio) {
        return res.status(400).json({ error: "Ses kaydı gönderilmedi." });
      }

      const audioBuffer = Buffer.from(body.audio, "base64");

      if (audioBuffer.length > 8 * 1024 * 1024) {
        return res.status(413).json({ error: "Ses kaydı çok büyük." });
      }

      const mime = String(body.mimeType || "audio/mp4");
      const extension = mime.includes("webm") ? "webm" : "m4a";

      const form = new FormData();
      form.append(
        "file",
        new Blob([audioBuffer], { type: mime }),
        `jarvis-audio.${extension}`
      );
      form.append("model", "gpt-4o-mini-transcribe");
      form.append("language", "tr");

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        body: form
      });

      const result = await response.json();

      if (!response.ok) {
        return res.status(500).json({
          error: result.error?.message || "Ses çözümlenemedi."
        });
      }

      return res.status(200).json({ text: result.text || "" });
    }

    // NORMAL JARVIS SOHBETİ
    const message = String(body.message || "").trim();
    const sessionId = String(body.sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "");

    if (!message) {
      return res.status(400).json({ error: "Mesaj boş olamaz." });
    }

    if (message.length > 5000) {
      return res.status(413).json({ error: "Mesaj çok uzun." });
    }

    const redisKey = `jarvis:history:${sessionId}`;
    let history = [];

    async function redisCommand(command) {
      if (!REDIS_URL || !REDIS_TOKEN) return null;

      const r = await fetch(REDIS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(command)
      });

      if (!r.ok) throw new Error("Sohbet hafızasına bağlanılamadı.");
      return r.json();
    }

    if (REDIS_URL && REDIS_TOKEN) {
      try {
        const saved = await redisCommand(["GET", redisKey]);
        if (saved?.result) {
          const parsed = JSON.parse(saved.result);
          if (Array.isArray(parsed)) history = parsed.slice(-12);
        }
      } catch (e) {
        console.error("Redis okuma hatası:", e);
      }
    }

    const input = [
      ...history,
      { role: "user", content: message }
    ];

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        instructions:
          "Sen JARVIS adlı Türkçe konuşan kişisel bir yapay zekâ asistanısın. " +
          "Kullanıcıya doğal, açık ve kısa cevaplar ver. " +
          "Kendini gerçek bir insan gibi tanıtma. " +
          "Bir cihazı veya uygulamayı kontrol ettiğini iddia etme; gerçekten bağlı olmayan işlemleri yaptığını söyleme. " +
          "Kullanıcıya Türkçe cevap ver.",
        input
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("OpenAI hatası:", result);
      return res.status(500).json({
        error: result.error?.message || "Yapay zekâ yanıt oluşturamadı."
      });
    }

    const answer = result.output_text || "Şu anda cevap oluşturamadım.";

    history = [
      ...input,
      { role: "assistant", content: answer }
    ].slice(-12);

    if (REDIS_URL && REDIS_TOKEN) {
      try {
        await redisCommand(["SET", redisKey, JSON.stringify(history)]);
      } catch (e) {
        console.error("Redis kayıt hatası:", e);
      }
    }

    return res.status(200).json({ answer });

  } catch (error) {
    console.error("JARVIS API hatası:", error);
    return res.status(500).json({
      error: error.message || "Sunucu hatası oluştu."
    });
  }
}
