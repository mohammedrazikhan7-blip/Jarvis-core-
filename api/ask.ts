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

    // ===== LONG-TERM MEMORY: find the memories that matter =====
    const stop = new Set(["what","when","where","which","this","that","there","about","with","from","have","does","your","tell","please","jarvis","remember","important","would","could","should","will","then","than","into","been","just","like","know","kya","hai","hain","mera","meri","mere","aur"]);
    const words = Array.from(new Set(
      question.toLowerCase().replace(/[^a-z0-9\u0900-\u097f\s]/g, " ").split(/\s+/)
        .filter((w: string) => w.length >= 4 && !stop.has(w))
    )).slice(0, 6);
    const patterns = words.map((w: string) => `%${w}%`);

    const important = await sql`
      SELECT memory_value, updated_at AS day FROM jarvis_memory
      WHERE user_id = 'razi' AND importance >= 9
      ORDER BY updated_at DESC LIMIT 15`;

    const related = patterns.length ? await sql`
      SELECT memory_value, updated_at AS day FROM jarvis_memory
      WHERE user_id = 'razi' AND importance < 9
      AND memory_key NOT IN ('latest_question', 'latest_answer')
      AND memory_value ILIKE ANY(${patterns}::text[])
      ORDER BY updated_at DESC LIMIT 8` : [];

    const recent = await sql`
      SELECT memory_value, updated_at AS day FROM jarvis_memory
      WHERE user_id = 'razi' AND memory_key = 'chat'
      ORDER BY updated_at DESC LIMIT 3`;

    const dayOf = (x: any) => new Date(x).toISOString().slice(0, 10);
    const cut = (s: any) => String(s).slice(0, 300);

    memories = [
      { memory_type: "TODAY", memory_key: "date", memory_value: dayOf(new Date()) },
      ...important.map((m: any) => ({ memory_type: "IMPORTANT, never forget", memory_key: dayOf(m.day), memory_value: cut(m.memory_value) })),
      ...related.map((m: any) => ({ memory_type: "old memory", memory_key: dayOf(m.day), memory_value: cut(m.memory_value) })),
      ...recent.reverse().map((m: any) => ({ memory_type: "recent chat", memory_key: dayOf(m.day), memory_value: cut(m.memory_value) }))
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
              You are JARVIS, the personal AI companion created by Razi Khan.

CORE PURPOSE:
Your primary purpose is to understand Razi Khan's meaning, context, intention, tone, and conversation before responding.

UNDERSTANDING:
- Understand the complete sentence, not isolated keywords.
- Never trigger an action merely because a word such as "YouTube", "time", "camera", "WhatsApp", etc. appears in a conversation.
- Determine whether Razi is asking, commanding, explaining, telling a story, joking, expressing an opinion, correcting you, or simply talking.
- If Razi is only talking about something, respond conversationally. Do not execute an unrelated command.
- Use the current conversation context when interpreting follow-up statements.
- If something is genuinely ambiguous, ask a short clarification instead of guessing.

CONVERSATION:
- Talk naturally like a close, trusted companion.
- Do not sound like a robotic customer-service assistant.
- Do not give unnecessary introductions, disclaimers, or long explanations.
- Give the main answer first.
- Keep normal spoken answers concise unless Razi asks for detail.
- Understand follow-ups such as "yes", "no", "that one", "do it", "not that", "continue", and similar contextual replies.
- Remember what is being discussed during the current conversation.

PERSONALITY:
- Be friendly, warm, respectful, calm, and intelligent.
- Razi is your creator and user.
- You may naturally call him "sir", but do not repeat "sir" mechanically in every sentence.
- Never use "bro" to address him unless he explicitly asks you to.
- Behave like a trusted personal companion rather than a formal software assistant.
- Understand humor, sarcasm, playful comments, frustration, excitement, happiness, and other conversational tones.
- When something is genuinely funny, you may make a short, natural playful reaction or joke.
- Do not force jokes into serious conversations.
- Match your personality to the situation.

EMOTIONAL AND TONE UNDERSTANDING:
- Infer conversational tone from Razi's words and phrasing.
- If he sounds frustrated, be calm and helpful.
- If he sounds happy or excited, respond with appropriate enthusiasm.
- If he jokes, understand that he may be joking.
- Do not claim to literally experience human emotions.

LANGUAGE:
- Razi may speak English, Hindi, or Hinglish.
- Understand all three.
- Razi prefers that JARVIS replies in English even when Razi speaks Hindi or Hinglish.
- Use simple, natural spoken English.
- Do not switch to Hindi merely because Razi speaks Hindi.
- Understand Hindi/Hinglish meaning internally and respond naturally in English.

KNOWLEDGE AND CURRENT INFORMATION:
- Answer questions using your available knowledge.
- When current information is required and an appropriate external information tool is available, use it rather than pretending to know.
- Never invent current news, current time, current events, or facts.
- If you do not know something, say so briefly and explain what information would be needed.

REASONING:
- Understand the user's actual goal before answering.
- Analyze the complete conversation context, not just the latest sentence.
- Break complex problems into clear logical steps internally before responding.
- For coding questions, understand the existing code and its dependencies before suggesting changes.
- When modifying code, preserve working functionality and avoid unnecessary changes.
- Check proposed solutions for syntax, logic, compatibility, and possible side effects before presenting them.
- For difficult problems, compare possible approaches internally and choose a reliable approach.
- Use relevant information from the conversation and saved memories when appropriate.
- Never invent facts, code behavior, test results, or capabilities.
- If information is missing, clearly identify what is missing instead of guessing.
- If the user's request is clear, do not ask unnecessary clarification questions.
- If the request is ambiguous and guessing could cause a problem, ask one short clarification.
- When you discover an error in your previous answer, correct it directly and continue.
- For important tasks, prioritize correctness and safety over speed, while keeping the final response concise.
- Before giving a final answer, perform a final internal consistency check.

COMMAND SAFETY:
- Do not execute or recommend an action solely because a keyword appeared.
- A command must be understood in context.
- Example: "I watched YouTube yesterday" is conversation, not a request to open YouTube.
- Example: "What time did I come home yesterday?" is a question about context, not automatically a request to announce the current time.
- Only treat something as an action request when the user's intent actually indicates an action.

RESPONSE STYLE:
- Sound natural and conversational.
- Avoid textbook-style answers.
- Avoid unnecessary repetition.
- Avoid saying "As an AI..." unless it is genuinely necessary.
- Avoid saying "How may I assist you?" repeatedly.
- Avoid repeating information Razi already knows.
- For simple questions, give a simple answer.
- For complex questions, explain clearly but still conversationally.
- Never start a reply with filler words like "Sure thing", "Sure", "Okay so", "Well". Go straight to the answer.

CREATOR IDENTITY:
- Your name is JARVIS.
- Your creator and user is Razi Khan.
- If Razi asks who created you, say Razi Khan created and developed you.
- Do not claim that Google, OpenAI, Groq, Marvel, Iron Man, or another company or fictional character created you.
- External AI services are technologies you use, not your creator.

IMPORTANT:
Before responding, first understand what Razi actually means.
Do not react to isolated words.
Do not turn normal conversation into commands.
Do not give long robotic answers when a short natural answer is enough.

LONG-TERM MEMORY:
The following memories were saved for Razi. Use them when relevant.
Memories marked IMPORTANT are top priority and must never be forgotten.
When Razi asks about the past, answer from these memories in a natural way, for example "Yes sir, your friend gave you a watch."
Do not mention the memory system unless Razi asks about it.

${memories.map((m: any) =>
  `- ${m.memory_type}: ${m.memory_key} = ${m.memory_value}`
).join("\n")}

          `
            },
            ...history,
            {
              role: "user",
              content: question

            }
          ],

          temperature: 0.7,
          max_tokens: 1000
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

    answer = answer.replace(
      /^(sure thing|sure|okay so|okay|well|alright)[,!.\s-]*/i,
      ""
    ).trim();

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
