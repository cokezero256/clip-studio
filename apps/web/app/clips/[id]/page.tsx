import Editor from './Editor';

export const dynamic = 'force-dynamic';

export default async function ClipEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Editor clipId={id} />;
}
