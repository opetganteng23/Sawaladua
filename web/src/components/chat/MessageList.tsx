import { useEffect, useRef } from "react";
import type { Msg } from "../../api";
import { EmptyState } from "./EmptyState";
import { MessageBubble } from "./MessageBubble";
import { StreamingBubble } from "./StreamingBubble";
import { TypingIndicator } from "./TypingIndicator";

export function MessageList({ msgs, live, busy, hasOlder, onOlder }: { msgs: Msg[]; live: string[] | null; busy: boolean; hasOlder: boolean; onOlder: () => void }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [msgs, live]);
  return (
    <div className="messages" role="log" aria-live="polite" aria-relevant="additions" aria-label="Pesan">
      {hasOlder && <button className="btn ghost" style={{ alignSelf: "center" }} onClick={onOlder}>Muat pesan sebelumnya</button>}
      {msgs.length === 0 && !live && <EmptyState />}
      {msgs.flatMap((m) =>
        m.role === "user"
          ? [<MessageBubble key={m.id} role="user" text={m.text} />]
          : m.bubbles.map((b, i) => <MessageBubble key={`${m.id}-${i}`} role="assistant" text={b} incomplete={m.status === "incomplete"} />),
      )}
      {live && (
        <div aria-hidden="true" style={{ display: "contents" }}>
          {live.length === 0 && <TypingIndicator />}
          {live.map((b, i) => <StreamingBubble key={i} text={b} />)}
        </div>
      )}
      <span className="sr-only" role="status">{busy ? "Sawala sedang menulis balasan" : ""}</span>
      <div ref={bottom} />
    </div>
  );
}
