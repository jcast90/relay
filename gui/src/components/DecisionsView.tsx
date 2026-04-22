import type { Channel, Decision } from "../types";
import { mentionContext, toUiChannel } from "../lib/channel";
import { renderWithMentions } from "../lib/mentions";

type Props = {
  decisions: Decision[];
  channel: Channel;
};

export function DecisionsView({ decisions, channel }: Props) {
  const ui = mentionContext(toUiChannel(channel));
  if (decisions.length === 0) {
    return <div className="chat-empty">No decisions recorded</div>;
  }
  return (
    <div className="chat-scroll decisions">
      {decisions.map((d) => (
        <div key={d.decisionId} className="decision-card">
          <h4>{d.title}</h4>
          <div className="meta">
            {d.decidedByName} · {formatTime(d.createdAt)}
          </div>
          <p>{renderWithMentions(d.description, ui)}</p>
          {d.rationale && (
            <p>
              <strong>Why:</strong> {renderWithMentions(d.rationale, ui)}
            </p>
          )}
          {d.alternatives.length > 0 && (
            <p>
              <strong>Alternatives:</strong> {d.alternatives.join(", ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
