interface LimitMeterProps {
  remainingSol: number;
  limitSol: number;
  spentSol: number;
  meterPercent: number;
}

/** Session spending-limit meter: remaining SOL of the limit, with a bar. */
export default function LimitMeter({
  remainingSol,
  limitSol,
  spentSol,
  meterPercent,
}: LimitMeterProps) {
  const empty = remainingSol <= 0;
  return (
    <div className="meter" aria-label="Session spending limit">
      <div className="meter-header">
        <span>Session limit</span>
        <strong>
          {remainingSol.toFixed(2)} / {limitSol.toFixed(2)} SOL left
        </strong>
      </div>
      <div className="meter-bar">
        <div
          className={`meter-fill${empty ? " meter-fill-empty" : ""}`}
          style={{ width: `${meterPercent}%` }}
        />
      </div>
      <p className="meter-note">
        {empty
          ? "Limit reached — no more paid calls in this session."
          : `${spentSol.toFixed(2)} SOL spent this session · 0.01 SOL per Summarize call.`}
      </p>
    </div>
  );
}
