# Privacy

culture atlas works with what you capture, so here is what happens to it. Engineering detail is in [docs/privacy.md](docs/privacy.md), which still lists items to confirm before a full release.

## What's stored

- **Your email address**, to sign you in.
- **Your captures**: photos, videos and recordings you choose to keep. Your library is private to your account.
- **What grows from them**: analyses, suggestions, saves, collections and your interest picks.
- **If you don't sign in**: a temporary session and its data, deleted after 24 hours.

## Nothing is analyzed until you ask

Keeping a capture saves it. Choosing **Explore** is what sends it for analysis.

## Who receives what

| Service | Receives | Why |
|---|---|---|
| **Concentrate** (model gateway) | The photo or video frames you explore, with metadata such as GPS removed | Reading the style. The app requires zero data retention on this route. |
| **Qloo** | Names and tags from the analysis, and your interest picks | Finding suggestions. Qloo doesn't receive your images or account id. |
| **Apple ShazamKit** (iOS) | An audio signature made on your phone, not the recording | Recognizing a song. The recognized artist and title go to our server. |
| **Resend** | Your email address and the sign-in link | Sending sign-in email |
| **Wikipedia** | Public reference names | Background on references |

Your photos and preferences are not used to train models by this project. Each service's own terms also apply.

## Deleting

Deleting a capture removes its media right away and its records within 24 hours. Facts about public works and names may remain, without any link to you.

## The live demo

The demo runs on the author's own machine. Its backups are not kept off that machine, and it may be reset. Please don't upload anything sensitive.

## Questions

Open an issue on this repository. For anything private, use the contact on the maintainer's GitHub profile.
