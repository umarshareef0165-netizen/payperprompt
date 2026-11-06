"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

/** Connect / disconnect button for the user's Phantom wallet (DevNet). */
export default function WalletButton() {
  const { connected, connecting, publicKey, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  if (connected && publicKey) {
    const address = publicKey.toBase58();
    return (
      <div className="wallet-connected">
        <span className="wallet-address" title={address}>
          {address.slice(0, 4)}…{address.slice(-4)}
        </span>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => disconnect()}
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="button button-primary"
      disabled={connecting}
      onClick={() => setVisible(true)}
    >
      {connecting ? "Connecting…" : "Connect Phantom (DevNet)"}
    </button>
  );
}
