# Study With Me

A study timer: https://conancchen.github.io/study/

## Friends

Sign in with Google to compare study time (today, this week, all time, streak) with friends. It runs on a free Supabase project. Until `config.js` is filled in, the Friends section stays hidden and the timer works the same as before.

Setup, once:

1. **Supabase project.** Create a free project at https://supabase.com. In **SQL Editor**, paste all of `supabase/schema.sql` and run it.
2. **Google sign-in.**
   - In https://console.cloud.google.com, go to **APIs & Services → Credentials → Create credentials → OAuth client ID** and choose **Web application**.
   - Under **Authorized redirect URIs**, add `https://<project-ref>.supabase.co/auth/v1/callback`.
   - Copy the client ID and secret into Supabase under **Authentication → Sign In / Providers → Google**, and turn it on.
3. **Redirect URLs.** In Supabase, open **Authentication → URL Configuration**. Set **Site URL** to `https://conancchen.github.io/study/` and add it under **Redirect URLs**.
4. **Config.** From **Project Settings → API**, copy the project URL and the `anon` public key into `config.js`. Both values are safe to publish, because row-level security decides what each person can read.

How it works:

- A study turn is uploaded once it's finished (on Break or Reset). The turn still running only counts locally.
- **Copy invite link** makes a link that makes you friends with whoever opens it. **Add by username** sends a request the other person has to accept.
- **Reset stats** clears this browser only. Sessions already uploaded stay on the leaderboard.
