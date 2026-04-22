type Props = {
  onOpenSettings: () => void;
};

export function WorkspaceRail({ onOpenSettings }: Props) {
  return (
    <div className="workspace-rail">
      <div className="rail-avatar" title="Relay workspace">R</div>
      <div className="rail-spacer" />
      <button className="rail-btn" title="Settings" onClick={onOpenSettings}>
        ⚙
      </button>
    </div>
  );
}
