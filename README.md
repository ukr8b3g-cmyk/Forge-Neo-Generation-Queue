# Forge Neo Generation Queue

[日本語 README](README.ja.md)

Queue **txt2img** jobs with Forge Neo's existing **Generate** button. Prepare the next prompt while the current job is running.

- One click adds one job; jobs run sequentially through Forge's existing pipeline.
- Generate turns **dark green during generation**, then returns to its normal color.
- A single line shows **Generating · Remaining: N**, including the current job and all waiting jobs. Details show only these unfinished jobs; completed and cancelled jobs disappear.
- Click the count to view details and cancel individual jobs. The popup does not push the page down.
- Optional Quicksettings toggle. **OFF by default.**
- Japanese for Japanese WebUI locales; English for English, unset/`None`, and other locales. Browser/OS language is not used.

## Installation

Choose either method below. **Install from URL does not require the extension to be listed in the Available index.** Install only one copy.

### Install from URL

1. Open **Extensions → Install from URL** in Forge Neo.
2. Enter `https://github.com/ukr8b3g-cmyk/Forge-Neo-Generation-Queue.git` and click **Install**.
3. Restart Forge Neo with your usual launcher and reload the browser.

### Git clone

Git is required. Open a terminal in your **Forge Neo installation folder** and run:

```sh
git clone https://github.com/ukr8b3g-cmyk/Forge-Neo-Generation-Queue.git extensions/Forge-Neo-Generation-Queue
```

Restart Forge Neo with your usual launcher and reload the browser. No additional Python packages are required. Do not clone a second copy if the extension is already installed.

## Update

After the queue has finished, stop Forge Neo. From the **Forge Neo installation folder**, run:

```sh
git -C extensions/Forge-Neo-Generation-Queue pull --ff-only
```

Restart Forge Neo and reload the browser. If Git reports local changes or diverging history, preserve those changes and resolve them before updating; do not force a reset.

These commands require a Git clone. A ZIP or manually copied installation without a `.git` directory cannot use `git pull`. Move that copy outside `extensions` as a backup, then use the installation command above. Keep only one enabled copy.

## Enable the queue

Open **Settings → Generation Queue**, check **Enable generation queue (txt2img)**, then click **Apply settings**.

![Generation Queue in the Settings sidebar](docs/images/settings-category.png)

The category appears alongside other extension settings. You can enable the queue here without adding it to Quicksettings.

## Add the toggle to Quicksettings

1. Open **Settings → User interface → Quicksettings List**. Searching Settings for `Quicksettings` also works.
2. Add **`forge_generation_queue_enabled`**. Keep your existing entries.
3. Click **Apply settings**, then **Reload UI**. Empty the queue before reloading the UI.
4. **Enable generation queue (txt2img)** now appears as a checkbox at the top of WebUI.

![Add forge_generation_queue_enabled to Quicksettings List](docs/images/quicksettings-list.png)

The screenshot shows the exact option to add. Other entries, such as Clip Skip, can stay as they are. Registration is manual; toggling the checkbox afterward does not require a restart.

## Generate and cancel

| Idle | Generating |
| --- | --- |
| ![Idle Generate button and empty queue](docs/images/queue-idle.png) | ![Green Generate button and three pending jobs](docs/images/queue-running.png) |

The orange button is idle. Green means a job is running. These user-supplied captures show the earlier **Queued** label, which counted waiting jobs only. The current **Remaining** count includes the running job: three accepted clicks mean three jobs until one finishes or is cancelled. The latest styling also reduces the gap below Generate.

![Expanded queue during generation: one running job and three waiting jobs](docs/images/queue-details.png)

The current expanded view shows **Generating · Remaining: 4**: **one running job and three waiting jobs**. The four rows match the remaining count. Completed and cancelled jobs are removed from this list. The running row now has a green background with white text; the screenshot was taken before that color update. Use **×** to interrupt the running job or cancel a waiting job.

1. Set the prompt and generation inputs, then click **Generate**.
2. While it runs, prepare the next inputs and click **Generate** again. Confirm the inputs have reached WebUI and the remaining count increases.
3. Jobs run in acceptance order. Batch Count and Batch Size are part of each job.
4. Click the count for details. **×** on a pending job cancels that job. **×** on the running job requests interruption; the next job starts after interruption finishes.
5. If generation fails, remaining jobs pause. Check the problem and click **Resume**. The failed job is not retried automatically.

The details popup uses a dark background at **80% opacity (20% transparency)** so the underlying controls show through only faintly.

The limit is **32 running and pending jobs combined**, across the instance. Turning the queue **OFF** stops new queue submissions and lets accepted jobs finish. The count and cancellation controls remain available until it drains.

## Scope and limitations

- **txt2img only.** img2img, standalone Hires, API generation, and other extensions' buttons retain their original entry points.
- Inputs are copied when accepted. Seed `-1`, Dynamic Prompts, and similar expansion use the normal generation pipeline. Expanded random prompts and external wildcard files are not frozen when submitted.
- Keep the **same model and shared settings** while jobs are queued. If saved Settings or style definitions change, the next job pauses without being discarded. Restore the original settings and resume, or cancel the job. Global configuration is not automatically restored.
- **Generate forever** is not combined with queue mode; txt2img auto-repeat is stopped while the queue is enabled.
- An ordinary reload of the same browser tab reconnects. Closing the tab does not cancel accepted jobs. Ownership does not transfer to another tab/browser.
- Queues are in memory. **Restarting Forge, Reload UI, or Reload script bodies does not preserve pending jobs.** Empty the queue first.
- The existing gallery shows the latest completed result. Image saving follows Forge's settings; this is not a separate image-history browser.

## Compatibility and verification

Version **0.1.0** was developed against Forge Neo commit `2900d5948a17ec993075fb810a695ce4f674bd0c`, Gradio **4.40.0**. Other versions have not been verified. If the txt2img event contract differs, the extension logs a warning and leaves the native Generate event unchanged.

Forge's source files are not edited. Its existing txt2img generation pipeline and GPU lock are used. Automated checks cover ordering, cancellation, input copies, locale selection, Gradio integration, and compact UI behavior. Isolated browser generation uses a CPU simulation and **does not establish real Forge/GPU acceptance**. Screenshots are cropped user-supplied WebUI captures. See [testing notes](TESTING.md).

## Disable

Remove the Quicksettings entry if added, disable the extension under **Extensions**, and restart Forge Neo. Existing workflows and generation settings are not rewritten.
