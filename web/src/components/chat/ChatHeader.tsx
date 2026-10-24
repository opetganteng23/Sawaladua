import type { Mood } from "../../api";
import { MoodIndicator } from "./MoodIndicator";

export function ChatHeader({ title, mood, showMood, onOpenSidebar }: { title: string; mood: Mood; showMood: boolean; onOpenSidebar: () => void }) {
  return (
    <div className="header">
      <button className="icon-btn menu-btn" aria-label="Buka riwayat" onClick={onOpenSidebar}>☰</button>
      <strong className="title">{title}</strong>
      <span className="spacer" />
      {showMood && <MoodIndicator mood={mood} />}
    </div>
  );
}
