import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN, type SessionInfo } from '@team-finder/domain';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api, errorCode, toErrorMessage } from '../lib/api.ts';
import { href, navigate } from '../lib/route.ts';
import { setSessionEnded } from '../lib/session-ended.ts';

// Auth-01..03 screens. They work without a session and never create a demo sandbox. A successful
// sign-up, join or login replaces every cached answer of the previous identity (demo or not).

function useSignedIn() {
  const queryClient = useQueryClient();
  return (info: SessionInfo) => {
    queryClient.removeQueries();
    queryClient.setQueryData(['session'], info);
    setSessionEnded(false);
    navigate(info.landingProjectId ? href.canvas(info.landingProjectId) : href.org());
  };
}

function AuthLayout({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <main className="fullscreen auth" data-testid={testId}>
      <div className="fullscreen-box auth-box">
        <p className="brand">Team Finder</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function Field({
  label,
  type = 'text',
  value,
  onChange,
  autoComplete,
  hint,
  required = true,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="field-hint muted">{hint}</span>}
    </label>
  );
}

function FormError({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="inline-error" data-testid="auth-error">
      {toErrorMessage(error)}
    </p>
  ) : null;
}

const submit = (fn: () => void) => (e: FormEvent) => {
  e.preventDefault();
  fn();
};

export function SignUpPage() {
  const signedIn = useSignedIn();
  const [f, setF] = useState({ orgName: '', hqAddress: '', name: '', email: '', password: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const m = useMutation({ mutationFn: () => api.signUp(f), onSuccess: signedIn });
  return (
    <AuthLayout title="Create your organization" testId="signup">
      <form className="auth-form" onSubmit={submit(() => m.mutate())}>
        <Field label="Organization name" value={f.orgName} onChange={set('orgName')} autoComplete="organization" />
        <Field
          label="Headquarters address"
          value={f.hqAddress}
          onChange={set('hqAddress')}
          autoComplete="street-address"
          required={false}
        />
        <Field label="Your name" value={f.name} onChange={set('name')} autoComplete="name" />
        <Field label="Work email" type="email" value={f.email} onChange={set('email')} autoComplete="email" />
        <Field
          label="Password"
          type="password"
          value={f.password}
          onChange={set('password')}
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN} characters.`}
        />
        <FormError error={m.error} />
        <button type="submit" className="btn btn-primary" disabled={m.isPending}>
          {m.isPending ? 'Creating…' : 'Create organization'}
        </button>
      </form>
      <p className="muted auth-alt">
        Already have an account? <a href={href.login()}>Sign in</a> · or <a href="#/">try the demo</a>
      </p>
    </AuthLayout>
  );
}

export function LoginPage() {
  const signedIn = useSignedIn();
  const [f, setF] = useState({ email: '', password: '' });
  const m = useMutation({ mutationFn: () => api.login(f), onSuccess: signedIn });
  return (
    <AuthLayout title="Sign in" testId="login">
      <form className="auth-form" onSubmit={submit(() => m.mutate())}>
        <Field
          label="Email"
          type="email"
          value={f.email}
          onChange={(email) => setF((x) => ({ ...x, email }))}
          autoComplete="email"
        />
        <Field
          label="Password"
          type="password"
          value={f.password}
          onChange={(password) => setF((x) => ({ ...x, password }))}
          autoComplete="current-password"
        />
        <FormError error={m.error} />
        <button type="submit" className="btn btn-primary" disabled={m.isPending}>
          {m.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="muted auth-alt">
        New here? <a href={href.signup()}>Create an organization</a> · or <a href="#/">try the demo</a>
      </p>
    </AuthLayout>
  );
}

export function JoinPage({ token }: { token: string }) {
  const signedIn = useSignedIn();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api.invite(token), retry: false });
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const m = useMutation({ mutationFn: () => api.join({ token, ...f }), onSuccess: signedIn });

  if (invite.isPending) return <main className="fullscreen" aria-busy="true" />;
  if (invite.isError) {
    return (
      <AuthLayout title="This invite link does not work" testId="join-invalid">
        <p>
          {errorCode(invite.error) === 'NOT_FOUND'
            ? 'It may have been replaced by a newer link. Ask your admin for the current one.'
            : toErrorMessage(invite.error)}
        </p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={`Join ${invite.data.orgName}`} testId="join">
      <form className="auth-form" onSubmit={submit(() => m.mutate())}>
        <Field label="Your name" value={f.name} onChange={set('name')} autoComplete="name" />
        <Field label="Work email" type="email" value={f.email} onChange={set('email')} autoComplete="email" />
        <Field
          label="Password"
          type="password"
          value={f.password}
          onChange={set('password')}
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN} characters.`}
        />
        <FormError error={m.error} />
        <button type="submit" className="btn btn-primary" disabled={m.isPending}>
          {m.isPending ? 'Joining…' : `Join ${invite.data.orgName}`}
        </button>
      </form>
    </AuthLayout>
  );
}
