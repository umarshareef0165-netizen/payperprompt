interface ExplainerProps {
  /** Plain-English sentence shown BEFORE the user signs anything. */
  text: string;
  /** The Solana Pay transfer-request URL being signed. */
  payUrl: string;
  recipient: string;
}

/**
 * Pre-sign explainer: in plain English, what the transaction will do,
 * what it costs, and what will be left of the session limit — plus the
 * Solana Pay request URL for transparency.
 */
export default function Explainer({ text, payUrl, recipient }: ExplainerProps) {
  return (
    <div className="explainer" role="status">
      <h3>Before you sign — read this</h3>
      <p>{text}</p>
      <dl className="explainer-details">
        <div>
          <dt>Paying to (agent wallet)</dt>
          <dd className="mono">{recipient}</dd>
        </div>
        <div>
          <dt>Solana Pay request</dt>
          <dd className="mono explainer-url">{payUrl}</dd>
        </div>
      </dl>
    </div>
  );
}
