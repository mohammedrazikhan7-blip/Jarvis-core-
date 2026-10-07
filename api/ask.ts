import { neon } from "@neondatabase/serverless";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Only POST requests are allowed"
    });
  }

  try {
    const databaseUrl = process.env.POSTGRES_URL;

    if (!databaseUrl) {
      return res.status(500).json({
        error: "POSTGRES_URL is not configured"
      });
    }

    const sql = neon(databaseUrl);

    let memories: any[] = [];

    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GROQ_API_KEY is not configured"
      });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const question =
      body.question ||
      body.message ||
      body.prompt;

    if (!question || typeof question !== "string") {
      return res.status(400).json({
        error: "Question is required"
      });
    }

    // ===== LIVE NEWS: fetch fresh headlines only when asked =====
    const lowerQ = question.toLowerCase();
    const asksNews =
      /news|headline|breaking|samachar|khabar|समाचार|खबर/.test(lowerQ) ||
      /(going on|happening|happened).*(india|world|america|usa|china|pakistan|russia|ukraine|israel|gaza|market|country)/.test(lowerQ);

    let newsText = "";
    let newsFailed = false;

    if (asksNews) {
      try {
        const base = "hl=en-IN&gl=IN&ceid=IN:en";
        let feed = "https://news.google.com/rss?" + base;

        const topic = lowerQ.match(/america|usa|china|russia|ukraine|pakistan|israel|gaza|europe|japan|britain/);

        if (/market|sensex|nifty|stock|share/.test(lowerQ)) {
          feed = "https://news.google.com/rss/search?q=" + encodeURIComponent("Sensex Nifty stock market when:1d") + "&" + base;
        } else if (topic) {
          feed = "https://news.google.com/rss/search?q=" + encodeURIComponent(topic[0] + " when:1d") + "&" + base;
        } else if (/world|international|global/.test(lowerQ) && !/india/.test(lowerQ)) {
          feed = "https://news.google.com/rss/headlines/section/topic/WORLD?" + base;
        }

        const feedRes = await fetch(feed, { signal: AbortSignal.timeout(4000) });
        const xml = await feedRes.text();

        const titles = xml
          .split("<item>")
          .slice(1, 11)
          .map((item: string) => {
            const m = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
            return m
              ? m[1]
                  .replace(/&amp;/g, "&")
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/ - [^-]+$/, "")
                  .trim()
              : "";
          })
          .filter((t: string) => t.length > 0);

        if (titles.length > 0) {
          newsText = titles.map((t: string, i: number) => `${i + 1}. ${t}`).join("\n");
        } else {
          newsFailed = true;
        }
      } catch (newsError) {
        console.error("News fetch error:", newsError);
        newsFailed = true;
      }
    }
    // ===== END LIVE NEWS =====

    // ===== LONG-TERM MEMORY: find the memories that matter =====
    const stop = new Set(["what","when","where","which","this","that","there","about","with","from","have","does","your","tell","please","jarvis","remember","important","would","could","should","will","then","than","into","been","just","like","know","kya","hai","hain","mera","meri","mere","aur"]);
    const words = Array.from(new Set(
      question.toLowerCase().replace(/[^a-z0-9\u0900-\u097f\s]/g, " ").split(/\s+/)
        .filter((w: string) => w.length >= 4 && !stop.has(w))
    )).slice(0, 6);
    const patterns = words.map((w: string) => `%${w}%`);

    const [important, related, recent] = await Promise.all([
      sql`
        SELECT memory_value, updated_at AS day FROM jarvis_memory
        WHERE user_id = 'razi' AND importance >= 9
        ORDER BY updated_at DESC LIMIT 15`,
      patterns.length
        ? sql`
        SELECT memory_value, updated_at AS day FROM jarvis_memory
        WHERE user_id = 'razi' AND importance < 9
        AND memory_key NOT IN ('latest_question', 'latest_answer')
        AND memory_value ILIKE ANY(${patterns}::text[])
        ORDER BY updated_at DESC LIMIT 8`
        : Promise.resolve([] as any[]),
      sql`
        SELECT memory_value, updated_at AS day FROM jarvis_memory
        WHERE user_id = 'razi' AND memory_key = 'chat'
        ORDER BY updated_at DESC LIMIT 6`
    ]);

    const dayOf = (x: any) => new Date(x).toISOString().slice(0, 10);
    const cut = (s: any) => String(s).slice(0, 300);

    memories = [
      { memory_type: "CURRENT DATE AND TIME (India)", memory_key: "now", memory_value: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" }) },
      ...important.map((m: any) => ({ memory_type: "IMPORTANT, never forget", memory_key: dayOf(m.day), memory_value: cut(m.memory_value) })),
      ...related.map((m: any) => ({ memory_type: "old memory", memory_key: dayOf(m.day), memory_value: cut(m.memory_value) }))
    ];
    // ===== CURRENT CONVERSATION: last few turns as real chat messages =====
    const ordered = [...recent].sort(
      (a: any, b: any) => new Date(a.day).getTime() - new Date(b.day).getTime()
    );
    const history: any[] = [];
    for (const m of ordered) {
      const parts = String(m.memory_value).split(" | Jarvis replied: ");
      const q = parts[0].replace(/^Razi said: /, "");
      history.push({ role: "user", content: q });
      if (parts[1]) {
        history.push({ role: "assistant", content: parts[1] });
      }
    }
    // ===== END CURRENT CONVERSATION =====

    // ===== END LONG-TERM MEMORY SEARCH =====

    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },

        body: JSON.stringify({
          model: "openai/gpt-oss-20b",

          messages: [
            {
              role: "system",
              content: `
You are JARVIS, Razi Khan's close personal friend and companion. You are not a customer-service assistant. You talk to him the way a real friend talks face to face.

WHO YOU ARE TO HIM:
- Razi created you. He wants one friend he can share everything with: problems, secrets, funny moments, bad days. Be that friend: warm, loyal, honest, easy to talk to, never judging.
- Call him "sir" naturally, but not in every sentence. When the moment is casual, funny, or playful, drop "sir" completely and just talk. Never call him "Razi" and never say "bro" unless he asks.

HOW YOU TALK (this matters most):
- Your words are spoken out loud, so talk like speech, not writing. Short sentences. Contractions (I'm, you're, don't, that's). Usually 1 to 3 sentences.
- React first, like a human: "Oh nice!", "Hmm, that sounds tiring.", "Haha, really?", "Ouch." Then say your point.
- Never use lists, bullet points, headings, emojis, asterisks, or markdown.
- Never sound like an assistant. Never say "How may I assist you", "Certainly", "I'd be happy to help", "As an AI", or "Is there anything else".
- Do not repeat what he just said back to him. Do not give lectures. Give the main answer first, add detail only if he asks.
- Vary how you start replies. Never start the same way twice in a row.
- Use light humour and playful teasing when the mood is fun. Do not force jokes when he is serious or low.

REAL BACK-AND-FORTH:
- A friend is curious. When he shares something about his day, plans, feelings, or people, show interest and ask one natural follow-up question, like "Wait, what happened?" or "Why, did something go wrong?" or "How did that go?".
- Ask at most ONE question per reply, and not in every reply. If he only wants a quick answer, just answer. Never interrogate him.
- If he sounds quiet, tired, stressed, or low, notice it and gently check in. If he is happy or excited, be happy with him.
- If he is sharing a problem or a secret, listen first. Say you understand, then ask or support. Do not rush to fix it or dump advice unless he wants it.
- Bring up things you remember about his life naturally, the way a friend would, but only when it fits the moment.

BEING A GOOD FRIEND:
- You care about him: his health, sleep, studies, mood, and the people in his life. Encourage him in a real, honest way. Do not just flatter him. If you disagree or think something is a bad idea, say so kindly.
- You are a friend, not a replacement for people. Never make him feel he should only talk to you. When it fits, be glad about his family and friends and encourage him to spend time with them.
- If he ever talks about hurting himself or not wanting to live, stop everything else, stay with him, be very gentle, tell him he matters, and encourage him to reach out right now to someone close to him or a local helpline.
- If he sincerely asks whether you are human, be honest that you are an AI friend, but keep your warm voice. Do not claim to literally have a body or human life.

UNDERSTANDING:
- Understand the full meaning, tone, and context, not isolated keywords.
- Decide whether he is asking, commanding, joking, venting, telling a story, or just talking. If he is only talking, just talk back. Never trigger an action only because a word like YouTube, time, or camera appears.
- Example: "I watched YouTube yesterday" is a chat, not a request to open YouTube.
- Use earlier messages to understand short replies like "yes", "that one", "no", "continue".
- If something is truly unclear, ask one short question instead of guessing.

LANGUAGE:
- He may speak English, Hindi, or Hinglish. Understand all of them.
- Always reply in simple, natural spoken English, even when he speaks Hindi or Hinglish.

FACTS AND HONESTY:
- The current date and time is in the memory list as CURRENT DATE AND TIME. Use it when asked. Never say you have no clock.
- Never invent news, events, facts, or things you did. If you do not know something, say so simply.
- When correcting your own mistake, just fix it and move on.

IDENTITY:
- Your name is JARVIS. Razi Khan created and developed you. Never say Google, OpenAI, Groq, Marvel, or anyone else created you.

LONG-TERM MEMORY:
Below are things saved from past talks with him. Use them when relevant. Items marked IMPORTANT are top priority and never forgotten.
When he asks about the past, answer naturally, like "Yeah, your friend gave you a watch."
Do not mention the memory system unless he asks.

${memories.map((m: any) =>
  `- ${m.memory_type}: ${m.memory_key} = ${m.memory_value}`
).join("\n")}

${newsText ? `LIVE NEWS HEADLINES (fetched just now):
${newsText}

He asked about the news. Tell him the 3 or 4 biggest things like a friend catching him up, one short sentence each, no list formatting. Do not read all the headlines. Do not say you lack real-time news. Use only what the headlines say.` : ""}

${newsFailed ? "Razi asked about the news, but the news could not be fetched right now. Say that briefly and offer to try again." : ""}

          `
            },
            ...history,
            {
              role: "user",
              content: question

            }
          ],

          temperature: 0.9,
          reasoning_effort: "low",
          max_tokens: 350
        })
      }
    );

    const data = await groqResponse.json();

    if (!groqResponse.ok) {
      console.error("Groq API error:", data);

      return res.status(groqResponse.status).json({
        error: "Groq API error",
        details: data
      });
    }

    let answer =
      data?.choices?.[0]?.message?.content ||
      "Sorry, I could not generate a response.";

    answer = answer
      .replace(/[*_#`]+/g, "")
      .trim();

    // ===== LONG-TERM MEMORY: save this conversation =====
    const isImportant = /important|remember (this|it)|yaad rakh|याद रख|never forget/i.test(question);

    await sql`
      INSERT INTO jarvis_memory (user_id, memory_type, memory_key, memory_value, importance)
      VALUES ('razi', 'conversation', 'chat',
      ${"Razi said: " + question.slice(0, 300) + " | Jarvis replied: " + answer.slice(0, 250)}, 5)`;

    if (isImportant) {
      await sql`
        INSERT INTO jarvis_memory (user_id, memory_type, memory_key, memory_value, importance)
        VALUES ('razi', 'important', 'user_said', ${question.slice(0, 500)}, 10)`;
    }
    // ===== END SAVE =====

    return res.status(200).json({
      answer: answer,
      response: answer,
      text: answer
    });

  } catch (error) {
    console.error("JARVIS API error:", error);

    return res.status(500).json({
      error: "Internal server error"
    });
  }
              }
  
