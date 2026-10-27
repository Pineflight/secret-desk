"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { Attachment } from "@secret-desk/core";
import type { CommitResult } from "@secret-desk/core";
import type { IssuanceView, SecretView } from "@secret-desk/runtime";
import { AttachmentThumb, EvidenceImage } from "@/components/Evidence";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, Checkbox, ErrorState, Notice, PageHeader, SectionLabel, Skeleton, StageBadge, TextAreaField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { countdown, formatDate } from "@/lib/format";
import { useMutation, useNow, useQuery } from "@/lib/hooks";
import { checkInfo, overallInfo } from "@/lib/status";
import { truncate } from "@/lib/tags";
import { useToast } from "@/lib/toast";

const MAX_BYTES = 5 * 1024 * 1024;
const MIMES = ["image/png", "image/jpeg", "image/webp"];

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const q = useQuery<IssuanceView>(`review:${id}`, () => api<IssuanceView>("GET", `reviews/${enc(id)}`));
  const sid = q.data?.secretId ?? null;
  const meta = useQuery<SecretView>(sid ? `secret:${sid}` : null, () => api<SecretView>("GET", `secrets/${enc(sid ?? "")}`));
  const now = useNow(1000);
  const [ticks, setTicks] = useState<Set<string>>(new Set());
  const [force, setForce] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<CommitResult | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileNote, setFileNote] = useState("");

  const confirm = useMutation(async (body: { ticks: string[]; note?: string; force?: boolean }) => api<CommitResult>("POST", `reviews/${enc(id)}/confirm`, body));
  const reject = useMutation(async () => api<{ revokedNew: boolean }>("POST", `reviews/${enc(id)}/reject`, note.trim() ? { note: note.trim() } : {}));
  const upload = useMutation(async (form: FormData, secretId: string, reportId: string) => api<Attachment>("POST", `evidence/${enc(secretId)}/${enc(reportId)}/attachments`, form));

  if (result) return <CommitDone result={result} />;
  if (q.error) {
    return (
      <>
        <p className="mb-2 text-sm"><Link href="/pruefen" className="text-primary hover:underline">← Alle Prüfungen</Link></p>
        <ErrorState error={q.error} onRetry={q.reload} />
        <p className="mt-3 text-sm text-muted-text">Prüfungen laufen nach kurzer Zeit ab. Erzeuge den Wert in dem Fall neu.</p>
      </>
    );
  }
  const r = q.data;
  if (!r) return <div className="space-y-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-80" /></div>;

  const report = r.report;
  const left = Date.parse(r.expiresAt) - now;
  const expired = left <= 0;
  const allTicked = report.checklist.every((c) => ticks.has(c.id));
  const failed = r.overall === "fail";
  const canConfirm = !expired && allTicked && (!failed || force);

  const doConfirm = async () => {
    const res = await confirm.run({ ticks: [...ticks], ...(note.trim() ? { note: note.trim() } : {}), ...(failed && force ? { force: true } : {}) });
    if (!res) return;
    if (res.ok) toast.success("Bestätigt und nach GitHub geschrieben.");
    setResult(res);
  };
  const doReject = async () => {
    const res = await reject.run();
    if (res) {
      toast.success(res.revokedNew ? "Abgelehnt. Der neue Wert wurde gelöscht." : "Abgelehnt.");
      router.push("/pruefen");
    }
  };
  const pickFile = async () => {
    setFileError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (!MIMES.includes(file.type)) return setFileError("Nur PNG, JPEG oder WebP sind erlaubt.");
    if (file.size > MAX_BYTES) return setFileError("Die Datei ist größer als 5 MB.");
    const form = new FormData();
    form.set("file", file);
    if (fileNote.trim()) form.set("note", fileNote.trim());
    const a = await upload.run(form, report.secretId, report.id);
    if (a) {
      setAttachments((l) => [...l, a]);
      setFileNote("");
      if (fileRef.current) fileRef.current.value = "";
      toast.success("Anlage hinzugefügt.");
    }
  };

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/pruefen" className="text-primary hover:underline">← Alle Prüfungen</Link></p>
      <PageHeader
        title={r.secretName}
        subtitle={<span className="flex flex-wrap items-center gap-2"><StageBadge stage={r.stage} /><Badge info={overallInfo(r.overall)} /><span>{r.kind === "manual" ? "Von Hand eingefügt" : "Automatisch erzeugt"} bei {r.provider}</span></span>}
        actions={
          <span className={`tabular inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${expired ? "bg-danger-light text-danger-text" : "bg-page text-ink ring-1 ring-inset ring-line"}`}>
            <Icon name="clock" className="h-4 w-4" />{expired ? "Abgelaufen, neu erzeugen" : `Noch ${countdown(left)}`}
          </span>
        }
      />
      {meta.data?.description ? <p className="mb-4 max-w-3xl text-sm text-muted-text" title={meta.data.description}>{truncate(meta.data.description, 200)}</p> : null}
      {expired ? <div className="mb-4"><Notice tone="danger" title="Diese Prüfung ist abgelaufen">Der Wert kann nicht mehr bestätigt werden. <Link href={`/secrets/${enc(r.secretId)}`} className="font-medium underline">Zum Secret, um einen neuen Wert zu erzeugen</Link></Notice></div> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <SectionLabel>Beleg</SectionLabel>
            <div className="mt-3"><EvidenceImage secretId={report.secretId} reportId={report.id} createdAt={report.createdAt} className="w-full" /></div>
            <p className="mt-3 text-xs text-muted">Fingerabdruck <span className="font-mono text-ink">{report.fingerprint}</span>. Zum späteren Abgleich, verrät den Wert nicht.</p>
          </Card>
          <Card>
            <SectionLabel>Automatische Prüfungen</SectionLabel>
            <ul className="mt-3 divide-y divide-line">
              {report.checks.map((c) => {
                const info = checkInfo(c.status);
                return (
                  <li key={c.id} className="flex items-start gap-3 py-3">
                    <Badge info={info} className="mt-0.5" />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="font-medium">{c.label}</p>
                      {c.expected || c.actual ? (
                        <p className="text-muted-text">{c.expected ? <>Sollwert: <span className="text-ink">{c.expected}</span></> : null}{c.expected && c.actual ? " · " : ""}{c.actual ? <>Istwert: <span className="text-ink">{c.actual}</span></> : null}</p>
                      ) : null}
                      {c.detail ? <p className="text-muted-text">{c.detail}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <SectionLabel>Das prüfst du selbst</SectionLabel>
            <fieldset className="mt-3 space-y-3">
              <legend className="sr-only">Prüfpunkte</legend>
              {report.checklist.map((c) => (
                <Checkbox key={c.id} checked={ticks.has(c.id)} disabled={expired} onChange={(v) => setTicks((s) => { const n = new Set(s); if (v) n.add(c.id); else n.delete(c.id); return n; })}>{c.text}</Checkbox>
              ))}
              {report.checklist.length === 0 ? <p className="text-sm text-muted-text">Keine Prüfpunkte.</p> : null}
            </fieldset>
            {failed ? (
              <div className="mt-4 space-y-2">
                <Notice tone="danger" title="Die automatische Prüfung ist fehlgeschlagen">Lehne den Wert besser ab. Willst du ihn trotzdem nutzen, schalte das hier bewusst frei.</Notice>
                <Checkbox checked={force} onChange={setForce} disabled={expired}>Trotz fehlgeschlagener Prüfung fortfahren</Checkbox>
              </div>
            ) : null}
            <div className="mt-4"><TextAreaField label="Notiz (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
            <p className="mt-4 text-xs text-muted-text">Es wird erst nach deiner Bestätigung etwas in GitHub geschrieben. Der alte Wert bleibt bis dahin gültig.</p>
            {confirm.error || reject.error ? <div className="mt-3"><Notice tone="danger">{(confirm.error ?? reject.error)?.message}</Notice></div> : null}
            <div className="mt-4 flex flex-col gap-2">
              <Button variant="primary" disabled={!canConfirm} loading={confirm.pending} onClick={() => void doConfirm()}><Icon name="check" />Bestätigen und nach GitHub schreiben</Button>
              <Button variant="secondary" loading={reject.pending} onClick={() => void doReject()}><Icon name="trash" />Ablehnen und neuen Wert löschen</Button>
              {!allTicked && !expired ? <p className="text-xs text-muted">Hake zuerst alle Prüfpunkte ab.</p> : null}
            </div>
          </Card>

          <Card>
            <SectionLabel>Eigener Screenshot als Anlage</SectionLabel>
            <div className="mt-3 space-y-3">
              <div className="space-y-1">
                <label htmlFor="anlage" className="block text-sm font-medium">Bilddatei (PNG, JPEG, WebP, bis 5 MB)</label>
                <input id="anlage" ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={() => setFileError(null)} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary-light file:px-3 file:py-1.5 file:text-primary" />
              </div>
              <TextAreaField label="Notiz zur Anlage (optional)" rows={1} value={fileNote} onChange={(e) => setFileNote(e.target.value)} />
              {fileError || upload.error ? <Notice tone="danger">{fileError ?? upload.error?.message}</Notice> : null}
              <Button loading={upload.pending} onClick={() => void pickFile()}><Icon name="upload" />Anlage hinzufügen</Button>
              {[...report.attachments, ...attachments].length > 0 ? (
                <div className="flex flex-wrap gap-2">{[...report.attachments, ...attachments].map((a) => <AttachmentThumb key={a.file} secretId={report.secretId} reportId={report.id} file={a.file} note={a.note} />)}</div>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function CommitDone({ result }: { result: CommitResult }) {
  const failedPlaces = result.places.filter((p) => p.outcome === "failed");
  return (
    <>
      <PageHeader title={result.ok ? "Nach GitHub geschrieben" : "Nicht vollständig geschrieben"} />
      <Card>
        {result.ok ? (
          <Notice tone="success" title="Alle Ziele sind aktuell">Der neue Wert gilt jetzt.</Notice>
        ) : (
          <Notice tone="danger" title={result.partial ? "Nur ein Teil der Ziele wurde aktualisiert" : "Nichts wurde geschrieben"}>Der alte Wert bleibt gültig. Die Prüfung bleibt offen, du kannst es erneut versuchen.</Notice>
        )}
        <SectionLabel className="mt-5">Ergebnis je Ziel</SectionLabel>
        <ul className="mt-2 divide-y divide-line text-sm">
          {result.places.map((p) => (
            <li key={p.place} className="flex items-center justify-between gap-3 py-2">
              <span>{p.place}</span>
              <span className="flex items-center gap-2">
                <Badge info={p.outcome === "failed" ? { label: "Fehlgeschlagen", tone: "danger", icon: "x" } : { label: p.outcome === "created" ? "Neu angelegt" : "Aktualisiert", tone: "success", icon: "check" }} />
                {p.error ? <span className="text-xs text-danger-text">{p.error}</span> : null}
              </span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-muted-text">Alter Wert widerrufen</dt><dd className="font-medium">{result.revokedOld ? "Ja" : "Nein"}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-text">Läuft ab am</dt><dd className="tabular font-medium">{result.expires ? formatDate(result.expires) : "kein Ablauf"}</dd></div>
        </dl>
        <div className="mt-5 flex gap-2">
          <Link href={`/secrets/${enc(result.secretId)}`} className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white">Zum Secret</Link>
          <Link href="/pruefen" className="rounded-xl border border-line px-4 py-2 text-sm font-medium">Weitere Prüfungen</Link>
        </div>
        {failedPlaces.length > 0 ? <p className="mt-3 text-xs text-muted">{failedPlaces.length} Ziel(e) fehlgeschlagen.</p> : null}
      </Card>
    </>
  );
}
