export default function PlaceholderPage({ title }: { title: string }) {
  return (
    <div>
      <h1 className="font-heading text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">This screen ships in a later milestone.</p>
    </div>
  );
}
