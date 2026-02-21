// Encodium — English
i18n.registerLang('en', {
  _name: 'English',
  _flag: '🇬🇧',

  // ── Login ──
  'login.password': 'Password',
  'login.submit': 'Sign in',

  // ── Nav ──
  'nav.admin': 'Administration',
  'nav.logout': 'Sign out',
  'nav.dashboard': 'Dashboard',
  'nav.library': 'Library',
  'nav.hardware': 'Hardware',
  'nav.logs': 'Logs',
  'nav.settings': 'Settings',

  // ── Dashboard stats ──
  'dash.videos': 'Videos',
  'dash.total_size': 'Total size',
  'dash.total_duration': 'Total duration',
  'dash.jobs': 'Encoding jobs',
  'dash.space_saved': 'Space saved',
  'dash.title': 'Dashboard',

  // ── Savings ──
  'dash.savings_detail': 'Encoding savings detail',
  'dash.files_encoded': 'Encoded files',
  'dash.size_before': 'Size before',
  'dash.size_after': 'Size after',
  'dash.space_won': 'Space saved',
  'dash.space_lost': 'Space lost',
  'dash.avg_ratio': 'Average ratio',
  'dash.after_label': 'After: {size}',
  'dash.before_label': 'Before: {size}',
  'dash.no_codec_data': 'No codec data',
  'dash.jobs_in_progress': '{total} ({encoding} in progress)',

  // ── Paths ──
  'dash.configured_paths': 'Configured paths',
  'dash.path_media': 'Media',
  'dash.path_thumbs': 'Thumbnails',
  'dash.path_encode': 'Encoding',

  // ── Scan ──
  'dash.scan_title': 'Scan media',
  'dash.scan_desc': 'Scan the media folder and index new video files.',
  'dash.scan_start': '▶ Start scan',
  'dash.scan_cancel': '⏹ Cancel',
  'toast.scan_started': 'Scan started',
  'toast.cancel_requested': 'Cancellation requested',
  'scan.progress': '{done}/{total} – {folder} ({skipped} skipped, {errors} errors)',
  'scan.cancelled': 'Scan cancelled',
  'scan.done': 'Done — {total} files, {errors} errors',

  // ── Sync ──
  'dash.sync_title': 'Sync database',
  'dash.sync_desc': 'Remove orphan entries and add new files without a full rescan.',
  'dash.sync_start': '🔄 Sync',
  'toast.sync_started': 'Sync started',
  'sync.progress': '{done}/{total} checked — {removed} removed, {added} added, {errors} errors',
  'sync.done': 'Done — {removed} removed, {added} added, {errors} errors',

  // ── Enrich ──
  'dash.enrich_title': 'Enrich metadata',
  'dash.enrich_desc': 'Extract codec, duration, resolution via ffprobe.',
  'dash.enrich_start': '▶ Enrich',
  'toast.enrich_started': 'Enrichment started',
  'enrich.progress': '{done}/{total} ({errors} errors)',
  'enrich.done': 'Done — {total} videos, {errors} errors',

  // ── Thumbs ──
  'dash.thumbs_title': 'Generate thumbnails',
  'dash.thumbs_desc': 'Create missing thumbnails.',
  'dash.thumbs_start': '▶ Generate',
  'toast.thumbs_started': 'Thumbnail generation started',
  'thumbs.progress': '{done}/{total} ({errors} errors)',
  'thumbs.done': 'Done — {total} thumbnails, {errors} errors',

  // ── Codec chart ──
  'dash.codec_dist': 'Codec distribution',
  'dash.encode_history': 'Encoding history',
  'chart.space_saved_gb': 'Space saved (GB)',
  'chart.files': 'Files',
  'chart.before_gb': 'Before (GB)',
  'chart.after_gb': 'After (GB)',

  // ── Clear DB ──
  'dash.clear_db_title': 'Clear database',
  'dash.clear_db_desc': 'Remove all videos and jobs. This action is irreversible.',
  'dash.clear_db_btn': '🗑 Clear DB',
  'confirm.clear_db': '⚠️ Are you sure you want to clear the entire database?\nThis action is irreversible.',
  'toast.db_cleared': 'Database cleared',

  // ── Library ──
  'lib.title': 'Video library',
  'lib.search': 'Search…',
  'lib.all_folders': 'All folders',
  'lib.all_codecs': 'All codecs',
  'lib.skip_all': 'All videos',
  'lib.skip_hide': 'Hide skipped',
  'lib.skip_only': 'Skipped only',
  'lib.unknown': 'Unknown',
  'lib.sort_name': 'Name',
  'lib.sort_size': 'Size',
  'lib.sort_duration': 'Duration',
  'lib.sort_resolution': 'Resolution',
  'lib.sort_date': 'Date',
  'lib.order_title': 'Sort order',
  'lib.n_selected': '{count} selected',
  'lib.n_selected_total': '{count} selected / {total} total',
  'lib.encode': '⚡ Encode',
  'lib.force_encode': '⚡ Force encode',
  'lib.delete': '🗑 Delete',
  'lib.sel_page': 'Select all (page)',
  'lib.sel_all': '☑ Select all',
  'lib.deselect': '✗ Deselect',
  'lib.no_video': 'No videos found',
  'toast.no_matching': 'No matching videos',
  'toast.n_selected': '{n} video(s) selected',

  // ── Delete ──
  'confirm.delete_videos': '⚠️ Permanently delete {n} video(s)?\nFiles will be erased from disk.',
  'toast.n_deleted': '{n} video(s) deleted',
  'toast.file_errors': '{n} file error(s)',

  // ── Encode queue ──
  'queue.title': 'Encoding queue',
  'queue.workers': 'Workers:',
  'queue.cancel_all': '⏹ Cancel all',
  'queue.clear': '🧹 Clear queue',
  'queue.encoding': 'In progress',
  'queue.pending': 'Pending',
  'queue.done': 'Completed',
  'queue.errors': 'Errors',
  'queue.active_workers': 'Active workers: {active}/{total}',
  'queue.no_jobs': 'No encoding jobs',

  // ── Job log ──
  'toast.log_unavailable': 'Log not available',
  'log.empty': '(empty)',
  'log.modal_title': 'Log — Job #{id}',

  // ── SSE updates ──
  'toast.job_skipped': 'Job #{id}: {reason}',
  'toast.encoding_done': 'Encoding done: job #{id}',
  'toast.encoding_error': 'Encoding error: job #{id} – {error}',

  // ── Workers ──
  'toast.workers_set': 'Workers set to {count}',
  'toast.jobs_cancelled': '{n} jobs cancelled',
  'toast.jobs_cleared': '{n} job(s) removed from queue',

  // ── Player ──
  'player.title': 'Video player',

  // ── Encode modal ──
  'modal.encode_title': '⚡ Encode videos',
  'modal.n_selected': '{n} video(s) selected',
  'modal.preset': 'Preset',
  'modal.container': 'Output container',
  'modal.container_auto': 'Auto (MKV for AV1, MP4 otherwise)',
  'modal.container_mkv': 'MKV (Matroska)',
  'modal.container_mp4': 'MP4',
  'modal.resolution': 'Output resolution',
  'modal.res_original': 'Original (no change)',
  'modal.res_1080': '1080p (Full HD)',
  'modal.res_720': '720p (HD)',
  'modal.res_480': '480p (SD)',
  'modal.tonemap': 'HDR → SDR (tonemapping)',
  'modal.replace': 'Replace originals',
  'modal.cancel': 'Cancel',
  'modal.submit': '▶ Start',
  'toast.select_preset': 'Please select a preset',
  'toast.jobs_added': '{nJobs} job(s) added',
  'toast.jobs_added_skipped': '{nJobs} job(s) added, {nSkipped} skipped (already in target codec)',

  // ── Hardware ──
  'hw.title': 'Hardware detection',
  'hw.refresh': '🔄 Refresh',
  'hw.presets_available': 'Available presets',
  'hw.nvidia': '🟢 NVIDIA NVENC',
  'hw.vaapi': '🔵 VA-API',
  'hw.cpu_only': '⚪ CPU only (libx265)',

  // ── Logs ──
  'logs.title': 'Real-time logs',
  'logs.all': 'All',
  'logs.success': 'Success',
  'logs.sources': 'Sources',
  'logs.autoscroll': 'Auto-scroll',
  'logs.clear': '🧹 Clear',

  // ── Settings ──
  'settings.title': 'Settings',
  'settings.schedule_title': 'Encoding schedule',
  'settings.schedule_desc': 'Limit encoding to a daily time range.',
  'settings.schedule_enable': 'Enable schedule',
  'settings.schedule_from': 'From',
  'settings.schedule_to': 'to',
  'settings.save': '💾 Save',
  'settings.webhook_title': 'Notifications (Webhook)',
  'settings.webhook_desc': 'Receive a Discord/HTTP notification when the encoding queue finishes.',
  'settings.webhook_enable': 'Enable webhook notifications',
  'settings.webhook_url': 'Webhook URL',
  'settings.presets_title': 'Custom presets',
  'settings.presets_desc': 'Create reusable encoding presets.',
  'settings.preset_new': '+ New preset',
  'settings.preset_name': 'Name',
  'settings.preset_codec': 'Codec',
  'settings.preset_cq': 'CQ/CRF',
  'settings.preset_container': 'Container',
  'settings.preset_resolution': 'Resolution',
  'settings.preset_tonemap': 'HDR → SDR',
  'settings.preset_create': '💾 Create',
  'settings.no_presets': 'No custom presets',
  'toast.schedule_saved': 'Schedule saved',
  'toast.webhook_saved': 'Notifications saved',
  'toast.preset_deleted': 'Preset deleted',
  'toast.name_required': 'Name required',
  'toast.preset_created': 'Preset created',

  // ── Errors ──
  'error.session_expired': 'Session expired',
  'error.invalid_response': 'Invalid response ({status})',
  'error.server_unreachable': 'Cannot connect to server',
  'error.dashboard': 'Dashboard error: {msg}',
  'error.library': 'Library error: {msg}',
  'error.encoding': 'Encoding error: {msg}',
  'error.hardware': 'Hardware error: {msg}',
  'error.generic': 'Error: {msg}',
});
