"use client";
import { useState } from "react";
import { attachmentUrl, evidenceSvgUrl } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { Dialog } from "./Dialog";

/** Beleg nur per <img>, nie inline eingesetzt. */
export function EvidenceImage({ secretId, reportId, createdAt, className = "", zoomable = false }: { secretId: string; reportId: string; createdAt: string; className?: string; zoomable?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const alt = t("meta.evidenceAlt", { date: formatDateTime(createdAt) });
  // eslint-disable-next-line @next/next/no-img-element
  const img = <img src={evidenceSvgUrl(secretId, reportId)} alt={alt} className={`rounded-xl border border-line bg-card ${className}`} loading="lazy" />;
  if (!zoomable) return img;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block rounded-xl text-left" aria-label={t("meta.enlarge", { alt })}>{img}</button>
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
  const t = useT();
  const [open, setOpen] = useState(false);
  const alt = note ? t("meta.attachmentAlt", { note }) : t("meta.attachmentImage");
  const src = attachmentUrl(secretId, reportId, file);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block overflow-hidden rounded-lg border border-line" aria-label={t("meta.enlarge", { alt })}>
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
