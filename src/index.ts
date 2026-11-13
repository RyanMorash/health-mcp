import { handleSafely } from "./http.js";

export default {
  fetch(request, env, ctx) {
    return handleSafely(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
