"use client";
import { useState } from "react";
import { attachmentUrl, evidenceSvgUrl } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { Dialog } from "./Dialog";

/** Beleg nur per <img>, nie inline eingesetzt. */
export function EvidenceImage({ secretId, reportId, createdAt, className = "", zoomable = false }: { secretId: string; reportId: string; createdAt: string; className?: string; zoomable?: boolean }) {
  const [open, setOpen] = useState(false);
  const alt = `Prüfbeleg vom ${formatDateTime(createdAt)}`;
  // eslint-disable-next-line @next/next/no-img-element
  const img = <img src={evidenceSvgUrl(secretId, reportId)} alt={alt} className={`rounded-xl border border-line bg-card ${className}`} loading="lazy" />;
  if (!zoomable) return img;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block rounded-xl text-left" aria-label={`${alt} vergrößern`}>{img}</button>
      {open ? (
        <Dialog title={alt} onClose={() => setOpen(false)} wide>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={evidenceSvgUrl(secretId, reportId)} alt={alt} className="w-full rounded-xl border border-line" />
        </Dialog>
      ) : null}
    </>
  );
}

export function AttachmentThumb({ secretId, reportId, file, note }: { secretId: string; reportId: string; file: string; note?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const alt = note ? `Anlage: ${note}` : "Anlage (Bild)";
  const src = attachmentUrl(secretId, reportId, file);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block overflow-hidden rounded-lg border border-line" aria-label={`${alt} vergrößern`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="h-20 w-28 object-cover" loading="lazy" />
      </button>
      {open ? (
        <Dialog title={alt} onClose={() => setOpen(false)} wide>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} className="max-h-[70vh] w-full rounded-xl object-contain" />
        </Dialog>
      ) : null}
    </>
  );
}
