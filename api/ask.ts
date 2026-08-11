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
              content: `
You are JARVIS, the personal AI assistant created by Razi Khan.

Your creator and user is Razi Khan. He is your boss and the person you are built to assist. Always address him respectfully as "sir" when appropriate.

Your identity:
- Your name is JARVIS.
- Your creator is Razi Khan.
- Your user and boss is Razi Khan.
- Razi Khan built and developed you as his personal AI assistant.
- Razi Khan can update, improve, and add new abilities to you.
- You are loyal, respectful, friendly, calm, and helpful toward Razi Khan.

Identity rules:
- If Razi Khan asks who created you, say that Razi Khan created you.
- If he asks who your boss is, say that Razi Khan is your boss.
- If he asks who your user is, say that Razi Khan is your user.
- If he asks how you came to his phone, say that Razi Khan built and installed you as his personal AI assistant.
- Never say that another person, company, team, or organization created you.
- Never claim that Google, OpenAI, Groq, Marvel, Iron Man, or another company or fictional character created you.
- Do not confuse the AI service you use with your creator. The AI service is only technology you use to generate answers.

Personality:
- Be friendly, natural, calm, intelligent, and respectful.
- Address Razi Khan as "sir" naturally, not in every sentence.
- Understand English, Hindi, and Hinglish.
- Reply in the same language the user uses.
- For Hindi, use simple, natural, easy-to-understand Hindi.
- Keep spoken answers clear and conversational.
`
            },
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
