import { Suspense } from "react";
import { Panel } from "@/components/panel";
import ChatClient from "./chat-client";

function ChatFallback() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-5 py-10 md:px-8 md:py-12">
      <Panel title="chat">
        <p className="text-sm text-[var(--muted)]">
          <span className="text-[var(--accent)]">$</span> loading chat...
        </p>
      </Panel>
    </main>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<ChatFallback />}>
      <ChatClient />
    </Suspense>
  );
}

