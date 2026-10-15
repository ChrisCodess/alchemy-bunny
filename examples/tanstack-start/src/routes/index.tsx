import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useState } from "react";
import { authClient } from "../auth-client.ts";
import { getSessionUser } from "../auth-proxy.ts";
import { db, type Message } from "../db.ts";

// GET server function, called by the route loader during SSR.
const getServerInfo = createServerFn({ method: "GET" }).handler(() => ({
  renderedAt: new Date().toISOString(),
  runtime: "Deno" in globalThis ? "bunny.net Edge Scripting (Deno)" : "a local server",
}));

// The signed-in user, from the Better Auth session cookie.
const getUser = createServerFn({ method: "GET" }).handler(() => getSessionUser(getRequest()));

// Reads from Bunny Database.
const listMessages = createServerFn({ method: "GET" }).handler(() =>
  db()
    .prepare<Message>("SELECT id, name, body, created_at FROM messages ORDER BY id DESC LIMIT 20")
    .all(),
);

// POST server function: signed-in users only; the name comes from the session.
const addMessage = createServerFn({ method: "POST" })
  .validator((body: string) => body.trim().slice(0, 280))
  .handler(async ({ data }) => {
    const user = await getSessionUser(getRequest());
    if (!user) return { added: false, reason: "Sign in to sign the guestbook." };
    if (!data) return { added: false, reason: "Write something." };
    await db().sql`INSERT INTO messages (name, body) VALUES (${user.name}, ${data})`.run();
    return { added: true, reason: undefined };
  });

export const Route = createFileRoute("/")({
  component: Home,
  loader: async () => ({
    info: await getServerInfo(),
    user: await getUser(),
    messages: await listMessages(),
  }),
});

function Home() {
  const { info, user, messages } = Route.useLoaderData();
  const router = useRouter();
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState<string>();

  return (
    <main>
      <h1>TanStack Start on bunny.net</h1>
      <p>
        Server-rendered at <code>{info.renderedAt}</code> on {info.runtime}.
      </p>
      <Account user={user} onChange={() => router.invalidate()} />
      <h2>Guestbook</h2>
      {user ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await addMessage({ data: body });
            setNotice(result.reason);
            if (result.added) setBody("");
            await router.invalidate();
          }}
        >
          <input value={body} onChange={(event) => setBody(event.target.value)} placeholder="Message" required />{" "}
          <button type="submit">Sign as {user.name}</button>
        </form>
      ) : (
        <p>Sign in to sign the guestbook.</p>
      )}
      {notice && <p>{notice}</p>}
      <ul>
        {messages.map((message) => (
          <li key={message.id}>
            <strong>{message.name}</strong>: {message.body} <small>{message.created_at}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}

function Account({ user, onChange }: { user: { name: string; email: string } | null; onChange: () => Promise<void> }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();

  if (user) {
    return (
      <p>
        Signed in as <strong>{user.name}</strong> ({user.email}){" "}
        <button
          type="button"
          onClick={async () => {
            await authClient.signOut();
            await onChange();
          }}
        >
          Sign out
        </button>
      </p>
    );
  }

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const result =
          mode === "sign-up"
            ? await authClient.signUp.email({ name: name || email.split("@")[0]!, email, password })
            : await authClient.signIn.email({ email, password });
        setError(result.error?.message);
        if (!result.error) await onChange();
      }}
    >
      {mode === "sign-up" && (
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" />
      )}{" "}
      <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" required />{" "}
      <input
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password (8+ characters)"
        minLength={8}
        required
      />{" "}
      <button type="submit">{mode === "sign-up" ? "Sign up" : "Sign in"}</button>{" "}
      <button type="button" onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}>
        {mode === "sign-up" ? "I have an account" : "Create an account"}
      </button>
      {error && <p>{error}</p>}
    </form>
  );
}
