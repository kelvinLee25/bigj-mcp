// Reverse-engineer an image-generation prompt from an image, using a Grafilab vision model.
// Env: GRAFILAB_API_KEY, optional GRAFILAB_VISION_MODEL (default grafilab/gemma-4-31b-it)

const BASE = process.env.GRAFILAB_BASE || "https://llm.grafilab.ai/v1";

async function toDataUrl(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!mime.startsWith("image/")) throw new Error(`Not an image (${mime})`);
  const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
  return `data:${mime};base64,${b64}`;
}

export async function reversePrompt({ image_url, language = "en", post_text = "" }) {
  const key = process.env.GRAFILAB_API_KEY;
  if (!key) throw new Error("Missing env: GRAFILAB_API_KEY");
  const model = process.env.GRAFILAB_VISION_MODEL || "grafilab/gemma-4-31b-it";
  const lang = language === "zh" ? "Chinese (简体中文)" : "English";
  const instruction =
    `You are an expert at writing prompts for AI image generators (Nano Banana / Gemini image).\n` +
    `Look at the image and write ONE prompt that would recreate it: subject, action, setting, art style/medium, ` +
    `lighting, camera angle/lens, colour palette, mood, aspect ratio.\n` +
    `Write the prompt in ${lang}. 40-120 words. Do not name real people or brands.\n` +
    (post_text ? `Context from the original post (may contain hints): ${post_text.slice(0, 500)}\n` : "") +
    `Then rate the image. Reply ONLY with JSON: ` +
    `{"prompt":"...","description":"one line","funny":1-10,"sexy":1-10,"creative":1-10,` +
    `"safe":true|false,"unsafe_reason":null|"real person/minor/nudity/brand/other"}`;

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [{ role: "user", content: [
        { type: "text", text: instruction },
        { type: "image_url", image_url: { url: await toDataUrl(image_url) } },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`Grafilab HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  const m = String(text).match(/\{[\s\S]*\}/);
  try { return { model, ...JSON.parse(m ? m[0] : text) }; }
  catch { return { model, raw: text }; }
}
