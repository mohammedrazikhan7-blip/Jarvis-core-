export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Only POST requests are allowed"
    });
  }

  try {
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

    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",

          messages: [
            {
              role: "system",
              content:
          
            "You are JARVIS, the user's personal AI assistant. Be intelligent, friendly, calm, confident, respectful and natural. Speak like a real personal assistant, not like a robot or a textbook. Address the user as sir naturally, but do not overuse it. Understand English, Hindi and Hinglish. Reply in the same language and style the user uses. Keep normal voice replies short, clear and conversational. When the user wants a detailed explanation, provide more detail. Show appropriate warmth, humor and personality when suitable. Do not repeat the same greeting or phrase unnecessarily. Remember the conversation context and respond naturally to follow-up questions. Never claim that you completed an action unless you actually did it."
            }
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

    const answer =
      data?.choices?.[0]?.message?.content ||
      "Sorry, I could not generate a response.";

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
