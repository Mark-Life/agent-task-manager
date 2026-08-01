import { RPCHandler } from "@orpc/server/fetch";
import { router } from "@workspace/api/router";

const handler = new RPCHandler(router);

async function handleRequest(request: Request) {
  const { response } = await handler.handle(request, {
    context: { headers: request.headers },
    prefix: "/rpc",
  });
  return response ?? new Response("Not found", { status: 404 });
}

export const GET = handleRequest;
export const POST = handleRequest;
