import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="page page--narrow">
      <h1 className="display display--medium">This page isn’t here.</h1>
      <p>
        <Link href="/" className="text-link">
          Back to Discover
        </Link>
      </p>
    </div>
  );
}
