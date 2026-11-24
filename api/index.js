
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST gerekli." });
  }

  try {
    const { action, clientId, messages } = req.body || {};

    if (action !== "chat") {
      return res.status(400).json({ error: "Bilinmeyen işlem." });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OpenAI API anahtarı ayarlanmamış." });
    }

    if (!/^[a-zA-Z0-9-]{10,80}$/.test(clientId || "")) {
      return res.status(400).json({ error: "Geçersiz istemci." });
    }

    const safeMessages = Array.isArray(messages)
      ? messages.slice(-24).filter(m =>
          ["user", "assistant"].includes(m.role) &&
          typeof m.content === "string"
        ).map(m => ({
          role: m.role,
          content: m.content.slice(0, 4000)
        }))
      : [];

    // Kalıcı hafıza için Upstash Redis kullanılır.
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const key = `jarvis:${clientId}:memory`;

    let savedMemory = [];

    if (redisUrl && redisToken) {
      try {
        const result = await fetch(
          `${redisUrl}/get/${encodeURIComponent(key)}`,
          { headers: { Authorization: `Bearer ${redisToken}` } }
        );
        const data = await result.json();
        if (data.result) savedMemory = JSON.parse(data.result);
      } catch {}
    }

    const combined = [...savedMemory, ...safeMessages].slice(-40);

    const instructions = `
Sen JARVIS adlı kişisel yapay zekâ asistanısın.

Kurallar:
- Kullanıcıyla Türkçe konuş.
- Doğal, akıcı ve özgün cümleler oluştur.
- Önceki konuşmaların bağlamını kullan.
- Gereksiz yere uzun cevap verme.
- Bilmediğin bilgileri uydurma.
- Gerçekleştirmediğin cihaz işlemlerini gerçekleştirmiş gibi gösterme.
- Kullanıcıya saygılı ve profesyonel hitap et.
- Kendini JARVIS olarak tanıt.

Erişilebilir geçmiş:
${JSON.stringify(combined).slice(-12000)}
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        instructions,
        input: safeMessages,
        max_output_tokens: 700
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || "OpenAI isteği başarısız."
      });
    }

    const reply = data.output_text || "Yanıt oluşturulamadı.";

    if (redisUrl && redisToken) {
      try {
        const updated = [...combined, {
          role: "assistant",
          content: reply
        }].slice(-40);

        await fetch(`${redisUrl}/set/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${redisToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(updated)
        });
      } catch {}
    }

    return res.status(200).json({ reply });

  } catch (error) {
    return res.status(500).json({
      error: "Sunucu hatası: " + error.message
    });
  }
}
