import { withSupabase } from "npm:@supabase/server@1.4.1";

const MODEL = new Supabase.ai.Session("gte-small");
const MAX_BATCH = 32;
const MAX_INPUT_CHARS = 16_000;

const handler = async (request: Request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405 });
  }

  let body: { inputs?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.inputs) || body.inputs.length < 1 || body.inputs.length > MAX_BATCH) {
    return Response.json({ error: `inputs must contain 1-${MAX_BATCH} strings` }, { status: 400 });
  }
  if (body.inputs.some((value) => typeof value !== "string" || value.length < 1 || value.length > MAX_INPUT_CHARS)) {
    return Response.json({ error: `each input must be a 1-${MAX_INPUT_CHARS} character string` }, { status: 400 });
  }

  const embeddings: number[][] = [];
  for (const input of body.inputs as string[]) {
    const output = await MODEL.run(input, { mean_pool: true, normalize: true });
    const embedding = Array.from(output as ArrayLike<number>);
    if (embedding.length !== 384) {
      return Response.json({ error: "gte-small returned an unexpected dimension" }, { status: 500 });
    }
    embeddings.push(embedding);
  }
  return Response.json({ model: "gte-small", dimensions: 384, embeddings });
};

export default {
  fetch: withSupabase({ auth: "secret" }, handler),
};
