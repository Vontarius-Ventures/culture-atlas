# culture atlas capture platform design specification

Version 2.1 · October 15, 2026 · Implementation specification, not an implementation-complete claim.

Build a cloud-hosted, multi-user culture atlas where each customer captures photos/videos with their own phone, browser or supported Meta glasses and uploads existing files. No World Observer runtime, founder device, local relay or customer server is required. Meta Glasses is included in the implementation and presented as **Experimental**. Concentrate is the initial model gateway, using the operator's existing credits after account/model qualification.

## Build order and authority

1. [Product and architecture](PRODUCT-AND-ARCHITECTURE.md)
2. [Backend and device contracts](BACKEND-CONTRACTS.md)
3. [Concentrate integration](CONCENTRATE.md)
4. [Agent access and collection sharing](AGENTS-AND-SHARING.md)
5. [Screens and interaction contract](SCREEN-CONTRACT.md)
6. [Mockup gallery](design/index.html), [tokens](design/tokens.css), [exact copy](design/copy.json), [image manifest](design/manifest.json)
7. [Release and acceptance plan](BUILD-AND-ACCEPTANCE.md)
8. [Configuration template](capture-platform.env.example), [feature flag defaults](feature-flags.json), [media contract schema](media-contract.schema.json), [example](media-contract.example.json)

This package supersedes the older build spec's image-only scope, Sensor-dependent glasses path, three-destination navigation and Featherless default for this new release. Existing Discover, Collections, Plans, Qloo, research, agent grant, and taste rules remain in force unless explicitly changed here. Existing code continues to use its current providers until the new adapter is implemented; documentation must not pretend configuration alone enables Concentrate.

Product/backend documents own behavior, safety and data contracts; screen contract/copy/tokens own exact UI; new mockups own new-screen composition. Existing v1 visual references still govern untouched discovery and collection surfaces. Written correction notes resolve generated-image variations. Preserve images verbatim and build accessible real controls, never screenshot-based UI. Mockups use illustrative media/statuses, not live results.

The [prior research scope](../../research/independent-multi-user-capture-scope.md) explains the investigation; this package makes the implementation decisions. [Concentrate findings](../../research/concentrate-integration-findings.md) record the dated external evidence. Source baseline: Atlas `02ec318`, Observer `bbecdd5`.

## Definition of done

Two unrelated users on independent networks use their own phones/glasses, cameras and uploads while all founder devices and Observer processes are off. Their data and commands remain isolated; interruptions recover; images/videos play; Concentrate produces validated discoveries when available; credit exhaustion never loses captures. Both iOS and Android ship the supported experimental implementation through permitted channels. Public release eligibility is separately verified for each platform; the word Experimental does not override SDK or store restrictions.

Agent API access and revocable collection sharing are required scope. The gallery includes nine generated capture references and four editable agent/sharing interface mockups.
