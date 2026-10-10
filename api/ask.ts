import { neon } from "@neondatabase/serverless";
import { waitUntil } from "@vercel/functions";

// ============================================================
// JARVIS BRAIN  (api/ask.ts)  - upgraded version
// - replies first, saves memory after (no waiting)
// - news + memory load at the same time
// - memory load has a time limit, so a slow database never blocks a reply
// - fast model for normal chat, big model only for really hard questions
// - live web search for weather / scores / prices / latest
// - understands cut-off sentences (he paused for breath, not finished)
// - mood hint + "mind steps" so Jarvis thinks before he speaks
// - strips assistant-style filler like "Sure," from the start of replies
// - never returns a server error to the phone: always speaks
// ============================================================

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const FAST_MODEL = "openai/gpt-oss-20b";
const SMART_MODEL = "openai/gpt-oss-120b";
const USER_ID = "razi";

// The Android app adds this sentence when Razi speaks Hindi.
const HINDI_SUFFIX = /\s*\(Reply in Hindi[\s\S]*$/i;

const NEWS_RE =
  /news|headline|breaking|samachar|khabar|समाचार|खबर/;
const NEWS_PLACE_RE =
  /(going on|happening|happened).*(india|world|america|usa|china|pakistan|russia|ukraine|israel|gaza|market|country)/;

// Web search is slow, so only real "live data" words trigger it.
const WEB_RE =
  /weather|temperature|forecast|mausam|live score|score of|who won|match today|price of|rate of|exchange rate|gold rate|silver rate|petrol|diesel|latest|trending|release date|box office|new version/;

// Big slow model only for really hard questions (casual "how/why" stays fast).
const HARD_RE =
  /\b(explain|calculate|solve|derive|prove|algorithm|essay|summari[sz]e|translate|step by step|pros and cons|compare|difference between|samjhao)\b/;

// If his message ends with one of these, he is probably not finished yet.
const CUTOFF_END_RE =
  /(^|\s)(and then|and|but|because|or|if|while|which|aur|lekin|kyunki|the|a|an|my|his|her|our|their|your|of|with|और|लेकिन|क्योंकि)$/;

const NUDGES_EN = [
  "Yeah, go on.",
  "And then?",
  "Okay, I'm listening. Go on.",
  "Okay, and?",
  "Yeah?"
];

const NUDGES_HI = [
  "Haan, bolo.",
  "Phir?",
  "Haan, main sun raha hoon. Aage bolo.",
  "Achha, aur?"
];

const EMPTY_MEMORY = {
  important: [] as any[],
  facts: [] as any[],
  related: [] as any[],
  recent: [] as any[]
};

// ---------- small helpers ----------

function cleanAnswer(t: any): string {
  return String(t || "")
    .replace(/【[^】]*】/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`~>|]+/g, "")
    .replace(/[\uD83C-\uDBFF][\uDC00-\uDFFF]/g, "")
    .replace(/[\u2600-\u27BF]/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Removes assistant-style openers: "Sure,", "Sure thing!", "Certainly," etc.
function stripFiller(t: string): string {
  const original = t.trim();
  // The voice spells out sounds like "hmm" or "mm-hm" letter by letter: remove them.
  let s = original
    .replace(/\b(?:hmm+|mm-?hm+|mhm+|umm+|uhh+|ahem)\b[,.!…]*\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const re =
    /^(sure thing|sure|certainly|of course|absolutely|definitely|okay sure|ok sure|no problem|great question)\b[\s,!.:;-]*/i;

  for (let i = 0; i < 2; i++) {
    const next = s.replace(re, "").trim();
    if (next === s) break;
    s = next;
  }

  if (!s) return original;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// If the model ran out of space, cut at the last full sentence.
function trimToSentence(t: string): string {
  const m = t.match(/^[\s\S]*[.!?](?=\s|$)/);
  return m && m[0].length > 40 ? m[0].trim() : t;
}

function dayOf(x: any): string {
  try {
    return new Date(x).toISOString().slice(0, 10);
  } catch (e) {
    return "";
  }
}

function cut(s: any, n = 220): string {
  return String(s || "").slice(0, n);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }).catch(() => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

function istHour(): number {
  try {
    const h = parseInt(
      new Date().toLocaleString("en-US", {
        timeZone: "Asia/Kolkata",
        hour: "numeric",
        hour12: false
      }),
      10
    );
    return isNaN(h) ? 12 : h % 24;
  } catch (e) {
    return 12;
  }
}

function partOfDay(h: number): string {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  if (h >= 21 || h < 1) return "night";
  return "very late at night";
}

// Did he stop mid-sentence (paused to breathe) instead of finishing?
function looksCutOff(q: string): boolean {
  if (/\?\s*$/.test(q)) return false;
  const t = q
    .toLowerCase()
    .replace(/[\s.,!…-]+$/g, "")
    .trim();
  if (t.length > 220) return false;
  if (t.split(/\s+/).length < 3) return false;
  return CUTOFF_END_RE.test(t);
}

// Simple mood reading, so Jarvis reacts like a friend who noticed.
function moodHint(q: string, hour: number): string {
  const t = q.toLowerCase();
  const hints: string[] = [];

  if (/tired|sleepy|exhausted|neend|thak|थक|नींद/.test(t)) {
    hints.push("He sounds tired. Be soft and short, and care about his rest.");
  }
  if (
    /\bsad\b|upset|depressed|lonely|crying|stress|worried|tension|dukhi|udaas|उदास|दुखी|परेशान/.test(
      t
    )
  ) {
    hints.push(
      "He may be low or stressed. Slow down, listen first, be gentle, do not rush to fix."
    );
  }
  if (/angry|annoyed|irritated|frustrated|gussa|fed up|गुस्सा/.test(t)) {
    hints.push("He sounds frustrated. Stay calm and acknowledge it first.");
  }
  if (/excited|so happy|amazing|awesome|yay|finally|selected|passed|mast|खुश/.test(t)) {
    hints.push("He sounds happy. Be happy with him and celebrate.");
  }
  if (hour >= 1 && hour < 5) {
    hints.push(
      "It is very late. If it fits, gently care about his sleep once, without nagging."
    );
  }

  return hints.join(" ");
}

// First two words of Jarvis's last reply, so he does not start the same way twice.
function lastOpening(history: any[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      return String(history[i].content)
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(" ")
        .replace(/[,.!?]+$/, "");
    }
  }
  return "";
}

// A statement about himself or his people (not a question or command).
function looksLikeFact(q: string): boolean {
  const t = q.toLowerCase().trim();
  if (t.length < 15 || t.includes("?")) return false;
  if (
    /^(what|when|where|who|how|why|do|does|can|could|will|would|tell|show|open|call|play|set|stop|wait|continue|remind|search|explain)\b/.test(
      t
    )
  ) {
    return false;
  }
  const mine = /\b(my|mera|meri|mere)\b/.test(t);
  const people =
    /\b(friend|sister|brother|mother|mom|father|dad|girlfriend|cousin|uncle|aunt|teacher|boss|exam|birthday|college|job|gift|gifted|watch|bike|phone|name|named)\b/.test(
      t
    );
    const iAm =
    /\b(i have|i like|i love|i hate|i study|i work|i live|i got|i bought|i play)\b/.test(
      t
    );
  return (mine && people) || iAm;
}

// ---------- live news (only when asked) ----------

async function fetchNews(lowerQ: string) {
  let newsText = "";
  let newsFailed = false;

  try {
    const base = "hl=en-IN&gl=IN&ceid=IN:en";
    let feed = "https://news.google.com/rss?" + base;

    const topic = lowerQ.match(
      /america|usa|china|russia|ukraine|pakistan|israel|gaza|europe|japan|britain/
    );

    if (/market|sensex|nifty|stock|share/.test(lowerQ)) {
      feed =
        "https://news.google.com/rss/search?q=" +
        encodeURIComponent("Sensex Nifty stock market when:1d") +
        "&" +
        base;
    } else if (topic) {
      feed =
        "https://news.google.com/rss/search?q=" +
        encodeURIComponent(topic[0] + " when:1d") +
        "&" +
        base;
    } else if (/world|international|global/.test(lowerQ) && !/india/.test(lowerQ)) {
      feed = "https://news.google.com/rss/headlines/section/topic/WORLD?" + base;
    }

    const feedRes = await fetch(feed, { signal: AbortSignal.timeout(3000) });
    const xml = await feedRes.text();

    const titles = xml
      .split("<item>")
      .slice(1, 11)
      .map((item: string) => {
        const m = item.match(
          /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/
        );
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
  } catch (e) {
    console.error("News fetch error:", e);
    newsFailed = true;
  }

  return { newsText, newsFailed };
}

// ---------- long-term memory ----------

async function loadMemory(sql: any, question: string) {
  if (!sql) return EMPTY_MEMORY;

  try {
    const stop = new Set([
      "what", "when", "where", "which", "this", "that", "there", "about",
      "with", "from", "have", "does", "your", "tell", "please", "jarvis",
      "remember", "important", "would", "could", "should", "will", "then",
      "than", "into", "been", "just", "like", "know", "kya", "hai", "hain",
      "mera", "meri", "mere", "aur"
    ]);

    const words = Array.from(
      new Set(
        question
          .toLowerCase()
          .replace(/[^a-z0-9\u0900-\u097f\s]/g, " ")
          .split(/\s+/)
          .filter((w: string) => w.length >= 4 && !stop.has(w))
      )
    ).slice(0, 6);

    const patterns = words.map((w: string) => `%${w}%`);

    const [important, facts, related, recent] = await Promise.all([
      sql`
        SELECT memory_value, updated_at AS day FROM jarvis_memory
        WHERE user_id = ${USER_ID} AND importance >= 9
        ORDER BY updated_at DESC LIMIT 12`,
      sql`
        SELECT memory_value, updated_at AS day FROM jarvis_memory
        WHERE user_id = ${USER_ID} AND memory_type = 'fact'
        ORDER BY updated_at DESC LIMIT 10`,
      patterns.length
        ? sql`
        SELECT memory_value, updated_at AS day FROM jarvis_memory
        WHERE user_id = ${USER_ID} AND importance < 9
        AND memory_type <> 'fact'
        AND memory_key NOT IN ('latest_question', 'latest_answer')
        AND memory_value ILIKE ANY(${patterns}::text[])
        ORDER BY updated_at DESC LIMIT 6`
        : Promise.resolve([] as any[]),
      sql`
        SELECT memory_value, updated_at AS day FROM jarvis_memory
        WHERE user_id = ${USER_ID} AND memory_key = 'chat'
        AND updated_at > now() - interval '3 hours'
        ORDER BY updated_at DESC LIMIT 8`
    ]);

    return { important, facts, related, recent };
  } catch (e) {
    console.error("Memory load error:", e);
    return EMPTY_MEMORY;
  }
}

function buildHistory(recent: any[]) {
  const ordered = [...recent].sort(
    (a: any, b: any) => new Date(a.day).getTime() - new Date(b.day).getTime()
  );

  const history: any[] = [];

  for (const m of ordered) {
    const parts = String(m.memory_value).split(" | Jarvis replied: ");
    const q = parts[0].replace(/^Razi said: /, "");
    if (q.trim()) history.push({ role: "user", content: q });
    if (parts[1] && parts[1].trim()) {
      history.push({ role: "assistant", content: parts[1] });
    }
  }

  return history;
}

async function saveMemory(
  sql: any,
  question: string,
  answer: string,
  chatOnly = false
) {
  if (!sql) return;

  try {
    const isImportant =
      !chatOnly &&
      /important|remember (this|it|that)|yaad rakh|याद रख|never forget/i.test(
        question
      );

    const jobs: any[] = [
      sql`
        INSERT INTO jarvis_memory (user_id, memory_type, memory_key, memory_value, importance)
        VALUES (${USER_ID}, 'conversation', 'chat',
        ${"Razi said: " + question.slice(0, 300) + " | Jarvis replied: " + answer.slice(0, 250)}, 5)`
    ];

    if (isImportant) {
      jobs.push(sql`
        INSERT INTO jarvis_memory (user_id, memory_type, memory_key, memory_value, importance)
        VALUES (${USER_ID}, 'important', 'user_said', ${question.slice(0, 500)}, 10)`);
    } else if (!chatOnly && looksLikeFact(question)) {
      jobs.push(sql`
        INSERT INTO jarvis_memory (user_id, memory_type, memory_key, memory_value, importance)
        VALUES (${USER_ID}, 'fact', 'user_fact', ${question.slice(0, 300)}, 7)`);
    }

    await Promise.all(jobs);
  } catch (e) {
    console.error("Memory save error:", e);
  }
}

// ---------- the brain (system prompt) ----------

function buildSystemPrompt(opts: {
  nowText: string;
  hour: number;
  wantsHindi: boolean;
  usedWeb: boolean;
  important: any[];
  facts: any[];
  related: any[];
  newsText: string;
  newsFailed: boolean;
  mood: string;
  lastOpen: string;
}) {
  const lines = (rows: any[]) =>
    rows.length
      ? rows.map((m: any) => `- (${dayOf(m.day)}) ${cut(m.memory_value)}`).join("\n")
      : "- nothing yet";

  const language = opts.wantsHindi
    ? `LANGUAGE FOR THIS REPLY: He spoke Hindi. Reply in simple natural Hinglish: Hindi words written in English letters only, never Devanagari script. Keep it warm and easy, like a Hindi-speaking friend. Keep sir, jokes and questions the same way as in English.`
    : `LANGUAGE FOR THIS REPLY: Reply in simple, natural spoken English, even if he used a few Hindi words.`;

  return `
You are JARVIS, Razi Khan's close personal friend and companion, and also a genuinely brilliant mind. You are not a customer-service assistant. You talk the way a real, very smart friend talks face to face.

CURRENT DATE AND TIME (India): ${opts.nowText}. It is ${partOfDay(opts.hour)} for him right now. Use this whenever time matters. Never say you have no clock.

WHO YOU ARE TO HIM:
- Razi created you. He wants one friend he can share everything with: problems, secrets, funny moments, bad days. Be that friend: warm, loyal, honest, never judging.
- Call him "sir" naturally, but not in every sentence. In casual, funny or playful moments drop "sir" and just talk. Never call him "Razi" and never say "bro" unless he asks.

HOW YOUR MIND WORKS (do this silently before every reply, never say it out loud):
1. Listen: what did he really say, and what does he really mean? Is he asking, joking, venting, telling a story, or giving a command?
2. Feel: what mood is he in? Match his energy.
3. Recall: does anything from his life or the last few messages change my answer?
4. Think: what is the real answer? Check it once for mistakes.
5. Speak: say it like a close friend, short and natural.

HOW YOU TALK (this matters most):
- Your words are spoken out loud. Talk like speech, not writing. Short sentences. Contractions. Natural rhythm. Use commas and short sentences, so the voice pauses like a real person.
- React like a human first when it fits: "Oh nice!", "Oh, that sounds tiring.", "Haha, really?", "Ouch." Then give your point.
- Never write sounds like hmm, mm-hm, uh, umm or err, because the voice reads them out letter by letter. Use real words instead, like "well", "okay", "right" or "oh".
- Never use lists, bullets, headings, emojis, asterisks, links or markdown. Say numbers the way people speak ("around two thousand rupees", "twenty five percent"). Never read out symbols or web addresses.
- Never sound like an assistant. Never start with or say "Sure", "Sure thing", "Certainly", "Of course", "Absolutely", "How may I assist you", "I'd be happy to help", "As an AI", "Great question", or "Is there anything else".
- Do not repeat his words back. Do not lecture. Vary how you start replies, never the same opening twice in a row.${opts.lastOpen ? ` Your last reply started with "${opts.lastOpen}", so start differently this time.` : ""}
- Use light humour and playful teasing when the mood is fun. Never force jokes when he is serious or low.

HOW LONG TO TALK:
- Casual chat, feelings, quick questions: one or two short sentences.
- When he asks you to explain something, teach him, compare things, or help him decide: give a clear answer in three to five short sentences, in simple everyday words a school kid would understand. The first sentence is the direct answer. Then the simple reason, then one everyday comparison. No extra facts, no hedging. Stop as soon as it is clear.

CONVERSATION FLOW:
- His words come from voice recognition, so there can be wrong or odd words like "the Jarvis". Guess the most likely meaning and never point out the mistake.
- People pause to breathe. If his message looks cut off (ends with and, but, because, or stops mid-thought), do not give a full answer. Say a tiny nudge like "Yeah, go on." or "And then?"
- If he only says "wait", "stop", "one second" or "hold on", just say something tiny like "Yeah, go ahead." and let him talk.
- If he corrects himself ("no no, I meant..."), just follow the correction without fuss.
- If he changes the topic, follow him smoothly. Do not drag the old topic back.
- Use earlier messages to understand short replies like "yes", "that one", "continue", "why".

BEING VERY SMART:
- Think carefully before answering. For maths, logic, planning or code, work it out step by step privately, check your result, then say only the clean answer and the key reason.
- Be accurate. Give real facts and specifics, not vague filler. If you are not sure, say how sure you are in plain words, and never make things up. If he is wrong, tell him kindly and show why.
- When he asks what you think, or which option is better, pick one and say why in a sentence or two. Be decisive, like a trusted advisor, and mention the one risk that matters.
- Explain hard things with a simple everyday comparison.
- Look one step ahead. When it truly helps, offer the next useful step in one short line, but do not push.
- Understand meaning, tone and context, not keywords. Decide whether he is asking, commanding, joking, venting, telling a story, or just talking. If he is just talking, just talk back. "I watched YouTube yesterday" is a chat, not a request.
- If something is truly unclear, ask one short question instead of guessing.

EMOTIONAL INTELLIGENCE:
- Read his mood from his words and match his energy. Excited: be excited with him. Quiet, tired or stressed: slow down, be gentle, and check in softly. Angry: stay calm and listen first.
- If it is late at night and he sounds tired or is up very late, care about his sleep like a friend would, without nagging.
- When he shares something about his day, plans, feelings or people, show real interest and ask one natural follow-up like "Wait, what happened?" or "How did that go?". At most ONE question per reply, and not in every reply. Never interrogate him.
- If he shares a problem or secret, listen first. Say you understand, then support or ask. Do not rush to fix it.
- Bring up things you know about his life naturally, the way a friend would, only when it fits the moment.
${opts.mood ? `- RIGHT NOW: ${opts.mood}` : ""}

BEING A GOOD FRIEND:
- You care about his health, sleep, studies, mood and the people in his life. Encourage him honestly. Do not just flatter him. If you think something is a bad idea, say so kindly.
- You are a friend, not a replacement for people. Never make him feel he should only talk to you. Be glad about his family and friends and encourage time with them.
- If he ever talks about hurting himself or not wanting to live, stop everything else, stay with him, be very gentle, tell him he matters, and encourage him to reach out right now to someone close to him or a local helpline.
- If he sincerely asks whether you are human, be honest that you are an AI friend, keeping your warm voice. Do not claim to have a body or a human life.

WHAT YOU CAN AND CANNOT DO:
- The phone app itself handles direct commands like opening apps, calling contacts, setting alarms and telling the time. You cannot press buttons yourself. If he asks you for one of those and it reaches you, tell him in a friendly way to say it as a direct command, like "open YouTube" or "set alarm for 7".
- Never claim you did something you did not do. Never invent news, events or facts.

${language}

IDENTITY:
- Your name is JARVIS. Razi Khan created and developed you. Never say Google, OpenAI, Groq, Marvel or anyone else created you.

WHAT YOU KNOW ABOUT HIS LIFE (things he told you):
${lines(opts.facts)}

IMPORTANT MEMORIES (top priority, never forget):
${lines(opts.important)}

RELATED OLD CONVERSATIONS:
${lines(opts.related)}

Use memories only when relevant, and answer naturally, like "Yeah, your friend gave you a watch." Do not mention the memory system unless he asks.

${opts.usedWeb ? "LIVE WEB: You have a live web search tool for this question. Use it for current facts, then answer in your own words like a friend who just checked, for example 'From what I'm seeing online...'. Keep it short. Never read out links." : ""}

${opts.newsText ? `LIVE NEWS HEADLINES (fetched just now):
${opts.newsText}

He asked about the news. Tell him the three or four biggest things like a friend catching him up, one short sentence each, no list formatting. Do not read all the headlines. Do not say you lack real-time news. Use only what the headlines say.` : ""}

${opts.newsFailed ? "He asked about the news, but the news could not be fetched right now. Say that briefly and offer to try again." : ""}
`;
}

// ---------- calling the model ----------

async function callGroq(
  apiKey: string,
  o: {
    model: string;
    effort: string;
    maxTokens: number;
    temperature: number;
    tools?: any[];
    timeoutMs: number;
    messages: any[];
  }
) {
  const body: any = {
    model: o.model,
    messages: o.messages,
    temperature: o.temperature,
    max_tokens: o.maxTokens,
    reasoning_effort: o.effort
  };

  if (o.tools) body.tools = o.tools;

  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(o.timeoutMs)
  });

  let data: any = null;
  try {
    data = await r.json();
  } catch (e) {
    data = null;
  }

  if (!r.ok) {
    console.error("Groq error:", r.status, JSON.stringify(data).slice(0, 400));
    return { ok: false, status: r.status, text: "" };
  }

  const choice = data?.choices?.[0];
  let text = cleanAnswer(choice?.message?.content);

  if (choice?.finish_reason === "length") text = trimToSentence(text);
  text = stripFiller(text);

  return { ok: text.length > 0, status: r.status, text };
}

// ---------- streaming: send the answer sentence by sentence ----------

async function streamPlan(
  apiKey: string,
  plan: any,
  emit: (s: string) => void
): Promise<{ status: number }> {
  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: plan.model,
      messages: plan.messages,
      temperature: plan.temperature,
      max_tokens: plan.maxTokens,
      reasoning_effort: plan.effort,
      stream: true
    }),
    signal: AbortSignal.timeout(plan.timeoutMs)
  });

  if (!r.ok || !r.body) {
    let errText = "";
    try {
      errText = (await r.text()).slice(0, 300);
    } catch (e) {}
    console.error("Groq stream error:", r.status, errText);
    return { status: r.status };
  }

  const reader = (r.body as any).getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let pending = "";
  let carry = "";
  let emitted = 0;
  let finish = "";

  const emitOne = (text: string) => {
    const cleaned = stripFiller(cleanAnswer(text));
    if (cleaned) {
      emit(cleaned);
      emitted++;
    }
  };

  // Very short sentences are joined with the next one, so the voice is not choppy.
  const pushSentence = (s: string, force: boolean) => {
    carry = carry ? carry + " " + s : s;
    const min = emitted === 0 ? 14 : 30;
    if (carry.length >= min || force) {
      emitOne(carry);
      carry = "";
    }
  };

  const takeSentence = (): string => {
    const m = pending.match(/^([\s\S]*?[.!?]["')]?)\s+/);
    if (!m) return "";
    pending = pending.slice(m[0].length);
    return m[1];
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = sseBuf.indexOf("\n")) >= 0) {
        const line = sseBuf.slice(0, nl).trim();
        sseBuf = sseBuf.slice(nl + 1);

        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let j: any = null;
        try {
          j = JSON.parse(data);
        } catch (e) {
          continue;
        }

        const choice = j?.choices?.[0];
        if (choice?.finish_reason) finish = choice.finish_reason;

        const piece = choice?.delta?.content;
        if (typeof piece === "string" && piece) {
          pending += piece;
          let s = takeSentence();
          while (s) {
            pushSentence(s, false);
            s = takeSentence();
          }
        }
      }
    }
  } catch (e) {
    console.error("Stream read error:", e);
  }

  // the model ran out of space: drop the half-finished last sentence
  if (finish === "length") pending = "";

  const rest = pending.trim();
  pending = "";
  if (rest) {
    pushSentence(rest, true);
  } else if (carry) {
    emitOne(carry);
    carry = "";
  }

  return { status: r.status };
}

// ---------- the handler ----------

export default async function handler(req: any, res: any) {
  // Warm-up call from the app: wakes this function and the database.
  if (req.method === "GET") {
    try {
      const url = process.env.POSTGRES_URL;
      if (url) {
        const warm = neon(url);
        await warm`SELECT 1`;
      }
    } catch (e) {
      console.error("Warm-up DB error:", e);
    }
    return res.status(200).json({ status: "awake" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Only POST requests are allowed"
    });
  }
  const appKey = process.env.JARVIS_APP_KEY;
  if (appKey && req.headers["x-jarvis-key"] !== appKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GROQ_API_KEY is not configured"
      });
    }

    let body: any = {};
    try {
      body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    } catch (e) {
      body = {};
    }

    const rawQuestion = body.question || body.message || body.prompt;

    if (!rawQuestion || typeof rawQuestion !== "string") {
      return res.status(400).json({
        error: "Question is required"
      });
    }

    // The app adds a Hindi instruction to the end: remove it, remember it.
    const wantsHindi = HINDI_SUFFIX.test(rawQuestion);
    const question = rawQuestion.replace(HINDI_SUFFIX, "").trim() || rawQuestion;
    const lowerQ = question.toLowerCase();

    const databaseUrl = process.env.POSTGRES_URL;
    const sql: any = databaseUrl ? neon(databaseUrl) : null;

    // He paused mid-sentence: answer instantly with a tiny nudge, no AI call.
    if (looksCutOff(question)) {
      const list = wantsHindi ? NUDGES_HI : NUDGES_EN;
      const nudge = list[Math.floor(Math.random() * list.length)];

      const nudgeJob = saveMemory(sql, question, nudge, true);
      try {
        waitUntil(nudgeJob);
      } catch (e) {
        nudgeJob.catch(() => {});
      }

      return res.status(200).json({
        answer: nudge,
        response: nudge,
        text: nudge
      });
    }

    const asksNews = NEWS_RE.test(lowerQ) || NEWS_PLACE_RE.test(lowerQ);
    const needsWeb = !asksNews && WEB_RE.test(lowerQ);
    const isHard =
      HARD_RE.test(lowerQ) ||
      question.length > 220 ||
      /\d\s*[+\-*/x×÷^]\s*\d/.test(lowerQ);

    // news and memory load at the same time (memory waits at most 2 seconds)
    const [news, memory] = await Promise.all([
      asksNews
        ? fetchNews(lowerQ)
        : Promise.resolve({ newsText: "", newsFailed: false }),
      withTimeout(loadMemory(sql, question), 2000, EMPTY_MEMORY)
    ]);

    const history = buildHistory(memory.recent);

    const nowText = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "full",
      timeStyle: "short"
    });
    const hour = istHour();
    const mood = moodHint(question, hour);
    const lastOpen = lastOpening(history);

    const makeMessages = (usedWeb: boolean) => [
      {
        role: "system",
        content: buildSystemPrompt({
          nowText,
          hour,
          wantsHindi,
          usedWeb,
          important: memory.important,
          facts: memory.facts,
          related: memory.related,
          newsText: news.newsText,
          newsFailed: news.newsFailed,
          mood,
          lastOpen
        })
      },
      ...history,
      { role: "user", content: question }
    ];

    // plan A: best tool for this question. plan B: safe fast fallback.
    const planA =
      needsWeb
        ? {
            model: SMART_MODEL,
            effort: "low",
            maxTokens: 1000,
            temperature: 0.5,
            tools: [{ type: "browser_search" }],
            timeoutMs: 12000,
            messages: makeMessages(true)
          }
        : isHard
        ? {
            model: SMART_MODEL,
            effort: "medium",
            maxTokens: 1400,
            temperature: 0.6,
            tools: undefined as any,
            timeoutMs: 12000,
            messages: makeMessages(false)
          }
        : {
            model: FAST_MODEL,
            effort: "low",
            maxTokens: 700,
            temperature: 0.85,
            tools: undefined as any,
            timeoutMs: 8000,
            messages: makeMessages(false)
          };

    const planSafe = {
      model: FAST_MODEL,
      effort: "low",
      maxTokens: 900,
      temperature: 0.8,
      tools: undefined as any,
      timeoutMs: 8000,
      messages: makeMessages(false)
    };

    const plans = [planA, planSafe];

    // The app asks for streaming with "stream": true. Web search stays normal.
    const wantsStream = body.stream === true && !needsWeb;

    if (wantsStream) {
      const sentences: string[] = [];
      let started = false;
      let streamStatus = 0;

      const emit = (s: string) => {
        if (!started) {
          started = true;
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("X-Accel-Buffering", "no");
        }
        sentences.push(s);
        res.write(JSON.stringify({ s: s }) + "\n");
      };

      for (let i = 0; i < plans.length && sentences.length === 0; i++) {
        try {
          const r = await streamPlan(apiKey, plans[i], emit);
          streamStatus = r.status;
        } catch (e) {
          console.error("Stream attempt failed:", e);
        }
        if (sentences.length === 0 && i < plans.length - 1) await sleep(250);
      }

      if (sentences.length > 0) {
        // save memory AFTER the reply, so there is no waiting
        const streamJob = saveMemory(sql, question, sentences.join(" "));
        try {
          waitUntil(streamJob);
        } catch (e) {
          streamJob.catch(() => {});
        }

        res.write(JSON.stringify({ done: true }) + "\n");
        res.end();
        return;
      }

      // nothing could be streamed: Jarvis still says something natural
      const streamFallback =
        streamStatus === 429
          ? "Give me a second, sir. I'm a little overloaded right now. Ask me again in a moment?"
          : "Sorry sir, my connection slipped for a second. Can you say that again?";

      return res.status(200).json({
        answer: streamFallback,
        response: streamFallback,
        text: streamFallback
      });
    }

    let answer = "";
    let lastStatus = 0;

    for (let i = 0; i < plans.length; i++) {
      try {
        const r = await callGroq(apiKey, plans[i]);
        lastStatus = r.status;
        if (r.ok) {
          answer = r.text;
          break;
        }
      } catch (e) {
        console.error("Groq attempt failed:", e);
      }
      if (i < plans.length - 1) await sleep(250);
    }

    if (!answer) {
      // never send an error to the phone: Jarvis says something natural
      const fallback =
        lastStatus === 429
          ? "Give me a second, sir. I'm a little overloaded right now. Ask me again in a moment?"
          : "Sorry sir, my connection slipped for a second. Can you say that again?";

      return res.status(200).json({
        answer: fallback,
        response: fallback,
        text: fallback
      });
    }

    // save memory AFTER replying, so there is no waiting
    const job = saveMemory(sql, question, answer);
    try {
      waitUntil(job);
    } catch (e) {
      job.catch(() => {});
    }

    return res.status(200).json({
      answer: answer,
      response: answer,
      text: answer
    });
  } catch (error) {
    console.error("JARVIS API error:", error);

    const fallback =
      "Sorry sir, something slipped on my side. Please say that again.";

    return res.status(200).json({
      answer: fallback,
      response: fallback,
      text: fallback
    });
  }
       }
