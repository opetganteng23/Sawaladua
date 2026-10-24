export function MessageBubble({ role, text, incomplete }: { role: "user" | "assistant"; text: string; incomplete?: boolean }) {
  return <div className={`bubble ${role === "user" ? "user" : "sawala"} ${incomplete ? "incomplete" : ""}`}>{text}</div>;
}
