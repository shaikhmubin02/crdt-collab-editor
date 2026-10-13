import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Editor } from '../../../components/Editor';

const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ docId: string }>;
}): Promise<Metadata> {
  const { docId } = await params;
  return { title: `${docId} · collab` };
}

export default async function DocumentPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  if (!DOC_ID.test(docId)) notFound();
  return <Editor docId={docId} />;
}
