"""Per-job settings on Forge's generation thread; UI settings stay live.

Keep the existing Options/StyleDatabase objects (including imported aliases).
Only their data lookup is scoped, so the UI never sees a running job's options.
Model loading still uses Forge's own refresh/reload functions.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from functools import wraps
from pathlib import Path
from threading import RLock, get_ident


def scoped_attribute(obj, attribute):
    existing = getattr(type(obj), "_fq_scoped_attribute", None)
    if existing is not None:
        return existing
    base = type(obj)
    current = ContextVar("forge_queue_" + attribute, default=None)

    class Scoped(base):
        def __getattribute__(self, name):
            value = current.get()
            if name == attribute and value is not None:
                return value
            return super().__getattribute__(name)

    # No module replacement: `from shared import opts` retains the same object.
    Scoped._fq_scoped_attribute = current
    if attribute == "data":
        original_save = base.save

        def save(self, *args, **kwargs):
            # Even a script saving preferences during generation must not write
            # the reservation's old values over the user's current preferences.
            token = current.set(None)
            try:
                return original_save(self, *args, **kwargs)
            finally:
                current.reset(token)

        Scoped.save = save
    object.__setattr__(obj, "__class__", Scoped)
    return current


class JobSettings:
    def __init__(self, shared, main_entry, sd_models):
        self.shared = shared
        self.entry = main_entry
        self.models = sd_models
        self.options = scoped_attribute(shared.opts, "data")
        self.styles = scoped_attribute(shared.prompt_styles, "styles")
        self.lock = RLock()
        self.active_thread = None
        self.refresh = main_entry.refresh_model_loading_parameters

        @wraps(self.refresh)
        def refresh(**kwargs):
            with self.lock:
                if self.active_thread is not None and self.active_thread != get_ident():
                    # The UI selection/save is already updated. Defer only its
                    # global model-loading refresh until the current job ends.
                    return
                return self.refresh(**kwargs)

        main_entry.refresh_model_loading_parameters = refresh

    def capture(self, selection, overrides=None):
        checkpoint, modules, dtype = selection
        overrides = overrides or {}
        checkpoint = overrides.get("sd_model_checkpoint", checkpoint)
        modules = overrides.get("forge_additional_modules", modules)
        dtype = overrides.get("forge_unet_storage_dtype", dtype)
        data = deepcopy(self.shared.opts.data)
        info = self.models.checkpoint_aliases.get(checkpoint)
        if info is None:
            raise ValueError(f"Selected checkpoint not found: {checkpoint}")
        paths = []
        for name in modules or []:
            path = self.entry.module_list.get(Path(name.replace("\\", "/")).name)
            if path is None:
                raise ValueError(f"Selected VAE / text encoder not found: {name}")
            paths.append(path)
        if dtype not in self.entry.forge_unet_storage_dtype_options:
            raise ValueError(f"Unknown diffusion storage type: {dtype}")
        data.update(sd_model_checkpoint=info.name, forge_additional_modules=sorted(paths),
                    forge_unet_storage_dtype=dtype)
        return dict(options=data, styles=deepcopy(self.shared.prompt_styles.styles),
                    checkpoint_file=info.filename)

    def _refresh_if_needed(self, restoring=False):
        info = self.models.checkpoint_aliases.get(self.shared.opts.sd_model_checkpoint)
        if info is None:
            return  # Do not select a fallback for a removed UI selection.
        dtype, lora = self.entry.forge_unet_storage_dtype_options.get(
            self.shared.opts.forge_unet_storage_dtype, (None, False))
        expected = dict(checkpoint_info=info,
                        additional_modules=self.shared.opts.forge_additional_modules,
                        unet_storage_dtype=dtype)
        lora = lora or info.filename.lower().endswith(".gguf")
        if (self.models.model_data.forge_loading_parameters != expected
                or self.entry.dynamic_args.online_lora != lora):
            processing = self.entry.processing
            unload = processing.need_global_unload
            same_loaded = getattr(self.models.model_data, "forge_hash", None) == str(expected)
            same_lora = self.entry.dynamic_args.online_lora == lora
            self.refresh(disable_log=True)
            # Merely restoring the UI's loading request must not evict the
            # cached model on every queued image. Actual model differences are
            # still handled by Forge's forge_model_reload hash comparison.
            if restoring or (same_loaded and same_lora):
                processing.need_global_unload = unload

    @contextmanager
    def activate(self, snapshot):
        data = deepcopy(snapshot["options"])
        info = self.models.checkpoint_aliases.get(data["sd_model_checkpoint"])
        if (info is None or info.filename != snapshot["checkpoint_file"]
                or not Path(info.filename).is_file()):
            raise FileNotFoundError("Queued checkpoint is no longer available: " + snapshot["checkpoint_file"])
        for path in data["forge_additional_modules"]:
            if not Path(path).is_file():
                raise FileNotFoundError("Queued VAE / text encoder is no longer available: " + path)
        with self.lock:
            self.active_thread = get_ident()
            option_token = self.options.set(data)
            style_token = self.styles.set(deepcopy(snapshot["styles"]))
        try:
            with self.lock:
                self._refresh_if_needed()
            yield
        finally:
            with self.lock:
                self.styles.reset(style_token)
                self.options.reset(option_token)
                self.active_thread = None
                self._refresh_if_needed(restoring=True)


def install_job_settings(shared, main_entry, sd_models):
    # Retain one scope/refresh wrapper across Reload UI, including a draining job.
    if not hasattr(shared, "_forge_queue_job_settings"):
        shared._forge_queue_job_settings = JobSettings(shared, main_entry, sd_models)
    return shared._forge_queue_job_settings
