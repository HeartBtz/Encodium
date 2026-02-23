// Encodium — Français (source)
i18n.registerLang('fr', {
  _name: 'Français',
  _flag: '🇫🇷',

  // ── Login ──
  'login.password': 'Mot de passe',
  'login.submit': 'Connexion',

  // ── Nav ──
  'nav.admin': 'Administration',
  'nav.logout': 'Déconnexion',
  'nav.dashboard': 'Tableau de bord',
  'nav.library': 'Bibliothèque',
  'nav.hardware': 'Matériel',
  'nav.logs': 'Logs',
  'nav.settings': 'Paramètres',

  // ── Dashboard stats ──
  'dash.videos': 'Vidéos',
  'dash.total_size': 'Taille totale',
  'dash.total_duration': 'Durée totale',
  'dash.jobs': 'Jobs encodage',
  'dash.space_saved': 'Espace gagné',
  'dash.title': 'Tableau de bord',

  // ── Savings ──
  'dash.savings_detail': 'Détail des économies d\'encodage',
  'dash.files_encoded': 'Fichiers encodés',
  'dash.size_before': 'Taille avant',
  'dash.size_after': 'Taille après',
  'dash.space_won': 'Espace gagné',
  'dash.space_lost': 'Espace perdu',
  'dash.avg_ratio': 'Ratio moyen',
  'dash.after_label': 'Après : {size}',
  'dash.before_label': 'Avant : {size}',
  'dash.no_codec_data': 'Aucune donnée codec',
  'dash.jobs_in_progress': '{total} ({encoding} en cours)',

  // ── Paths ──
  'dash.configured_paths': 'Chemins configurés',
  'dash.path_media': 'Médias',
  'dash.path_thumbs': 'Miniatures',
  'dash.path_encode': 'Encodage',

  // ── Scan ──

  // ── Sync ──

  // ── Enrich ──

  // ── Thumbs ──

  // ── Codec chart ──
  'dash.codec_dist': 'Distribution des codecs',
  'dash.encode_history': 'Historique d\'encodage',
  'chart.space_saved_gb': 'Espace gagné (GB)',
  'chart.files': 'Fichiers',
  'chart.before_gb': 'Avant (GB)',
  'chart.after_gb': 'Après (GB)',

  // ── Clear DB ──
  'dash.clear_db_title': 'Vider la base de données',
  'dash.clear_db_desc': 'Supprime toutes les vidéos et jobs. Action irréversible.',
  'dash.clear_db_btn': '🗑 Vider la BDD',
  'confirm.clear_db': '⚠️ Êtes-vous sûr de vouloir vider toute la base de données ?\nCette action est irréversible.',
  'toast.db_cleared': 'Base de données vidée',

  // ── Library ──
  'lib.title': 'Bibliothèque vidéo',
  'lib.search': 'Rechercher…',
  'lib.all_folders': 'Tous les dossiers',
  'lib.all_codecs': 'Tous codecs',
  'lib.skip_all': 'Toutes les vidéos',
  'lib.skip_hide': 'Masquer skip',
  'lib.skip_only': 'Skip uniquement',
  'lib.fail_all': 'Toutes (erreurs incl.)',
  'lib.fail_hide': 'Masquer échecs',
  'lib.fail_only': 'Échecs uniquement',
  'lib.fail_tag': 'Échec d\'encodage détecté',
  'lib.skip_tag': 'Encodage ignoré (résultat plus gros)',
  'lib.unknown': 'Inconnu',
  'lib.sort_name': 'Nom',
  'lib.sort_size': 'Taille',
  'lib.sort_duration': 'Durée',
  'lib.sort_resolution': 'Résolution',
  'lib.sort_date': 'Date',
  'lib.order_title': 'Ordre de tri',
  'lib.n_selected': '{count} sélectionné(s)',
  'lib.n_selected_total': '{count} sélectionné(s) / {total} total',
  'lib.encode': '⚡ Encoder',
  'lib.force_encode': '⚡ Forcer l\'encodage',
  'lib.delete': '🗑 Supprimer',
  'lib.sel_page': 'Tout sélect. (page)',
  'lib.sel_all': '☑ Tout sélect.',
  'lib.deselect': '✗ Décocher',
  'lib.no_video': 'Aucune vidéo trouvée',
  'lib.play': 'Lire',
  'toast.no_matching': 'Aucune vidéo correspondante',
  'toast.n_selected': '{n} vidéo(s) sélectionnée(s)',

  // ── Delete ──
  'confirm.delete_videos': '⚠️ Supprimer {n} vidéo(s) définitivement ?\nLes fichiers seront effacés du disque.',
  'toast.n_deleted': '{n} vidéo(s) supprimée(s)',
  'toast.file_errors': '{n} erreur(s) fichier',

  // ── Encode queue ──
  'queue.title': 'File d\'encodage',
  'queue.workers': 'Workers :',
  'queue.cancel_all': '⏹ Tout annuler',
  'queue.clear': '🧹 Vider la file',
  'queue.pause': '⏸ Pause',
  'queue.resume': '▶ Reprendre',
  'queue.paused': 'EN PAUSE',
  'queue.cancel_job': 'Annuler cet encodage',
  'queue.force_kill': 'Forcer l\'arrêt (SIGKILL)',
  'queue.force_kill_confirm': 'Êtes-vous sûr de vouloir forcer l\'arrêt de ce job ? Le process ffmpeg sera tué immédiatement.',
  'queue.cancel_all_confirm': 'Annuler TOUS les jobs (en cours + en attente) ?',
  'queue.encoding': 'En cours',
  'queue.pending': 'En attente',
  'queue.done': 'Terminés',
  'queue.errors': 'Erreurs',
  'queue.active_workers': 'Workers actifs : {active}/{total}',
  'queue.no_jobs': 'Aucun job d\'encodage',
  'queue.priority_up': 'Priorité +',
  'queue.priority_down': 'Priorité −',
  'queue.view_log': 'Voir le log',

  // ── Job log ──
  'toast.log_unavailable': 'Log non disponible',
  'log.empty': '(vide)',
  'log.modal_title': 'Log — Job #{id}',

  // ── SSE updates ──
  'toast.proxy_expired': '⚠️ Session proxy expirée — rechargement automatique…',
  'toast.job_skipped': 'Job #{id} : {reason}',
  'toast.encoding_done': 'Encodage terminé : job #{id}',
  'toast.encoding_error': 'Erreur encodage : job #{id} – {error}',

  // ── Workers ──
  'toast.workers_set': 'Workers réglés à {count}',
  'toast.jobs_cancelled': '{n} jobs annulés',
  'toast.jobs_cleared': '{n} job(s) supprimé(s) de la file',
  'toast.queue_paused': 'File d\'encodage en pause',
  'toast.queue_resumed': 'File d\'encodage reprise',

  // ── Player ──
  'player.title': 'Lecture vidéo',

  // ── Encode modal ──
  'modal.encode_title': '⚡ Encoder des vidéos',
  'modal.n_selected': '{n} vidéo(s) sélectionnée(s)',
  'modal.preset': 'Preset',
  'modal.container': 'Conteneur de sortie',
  'modal.container_auto': 'Auto (MKV pour AV1, MP4 sinon)',
  'modal.container_mkv': 'MKV (Matroska)',
  'modal.container_mp4': 'MP4',
  'modal.resolution': 'Résolution de sortie',
  'modal.res_original': 'Originale (pas de changement)',
  'modal.res_1080': '1080p (Full HD)',
  'modal.res_720': '720p (HD)',
  'modal.res_480': '480p (SD)',
  'modal.tonemap': 'HDR → SDR (tonemapping)',
  'modal.replace': 'Remplacer les originaux',
  'modal.cancel': 'Annuler',
  'modal.submit': '▶ Lancer',
  'toast.select_preset': 'Sélectionnez un preset',
  'toast.jobs_added': '{nJobs} job(s) ajouté(s)',
  'toast.jobs_added_skipped': '{nJobs} job(s) ajouté(s), {nSkipped} ignoré(s) (déjà dans le codec cible)',

  // ── Hardware ──
  'hw.title': 'Détection matérielle',
  'hw.refresh': '🔄 Rafraîchir',
  'hw.presets_available': 'Presets disponibles',
  'hw.nvidia': '🟢 NVIDIA NVENC',
  'hw.vaapi': '🔵 VA-API',
  'hw.cpu_only': '⚪ CPU uniquement (libx265)',

  // ── Logs ──
  'logs.title': 'Logs en temps réel',
  'logs.all': 'Tous',
  'logs.success': 'Succès',
  'logs.sources': 'Sources',
  'logs.autoscroll': 'Auto-scroll',
  'logs.clear': '🧹 Vider',

  // ── Settings ──
  'settings.title': 'Paramètres',
  'settings.schedule_title': 'Planification d\'encodage',
  'settings.schedule_desc': 'Limiter l\'encodage à une plage horaire quotidienne.',
  'settings.schedule_enable': 'Activer la planification',
  'settings.schedule_from': 'De',
  'settings.schedule_to': 'à',
  'settings.save': '💾 Enregistrer',
  'settings.webhook_title': 'Notifications (Webhook)',
  'settings.webhook_desc': 'Recevoir une notification Discord/HTTP à la fin de la file d\'encodage.',
  'settings.webhook_enable': 'Activer les notifications webhook',
  'settings.webhook_url': 'URL du webhook',
  'settings.presets_title': 'Presets personnalisés',
  'settings.presets_desc': 'Créer des presets d\'encodage réutilisables.',
  'settings.preset_new': '+ Nouveau preset',
  'settings.preset_name': 'Nom',
  'settings.preset_codec': 'Codec',
  'settings.preset_cq': 'CQ/CRF',
  'settings.preset_container': 'Conteneur',
  'settings.preset_resolution': 'Résolution',
  'settings.preset_tonemap': 'HDR → SDR',
  'settings.preset_create': '💾 Créer',
  'settings.no_presets': 'Aucun preset personnalisé',
  'toast.schedule_saved': 'Planification enregistrée',
  'toast.webhook_saved': 'Notifications enregistrées',
  'toast.preset_deleted': 'Preset supprimé',
  'toast.name_required': 'Nom requis',
  'toast.preset_created': 'Preset créé',

  // ── Errors ──
  'error.session_expired': 'Session expirée',
  'error.invalid_response': 'Réponse invalide ({status})',
  'error.server_unreachable': 'Connexion au serveur impossible',
  'error.dashboard': 'Erreur dashboard : {msg}',
  'error.library': 'Erreur bibliothèque : {msg}',
  'error.encoding': 'Erreur encodage : {msg}',
  'error.hardware': 'Erreur matériel : {msg}',
  'error.generic': 'Erreur : {msg}',

  // ── Sources / File Browser ──
  'settings.sources_title': 'Dossiers sources',
  'settings.sources_desc': 'Gérez les dossiers contenant vos médias à encoder.',
  'settings.sources_add': '📁 Ajouter un dossier',
  'settings.sources_remove': 'Supprimer cette source',
  'settings.sources_empty': 'Aucun dossier source configuré. Ajoutez-en un ci-dessous.',
  'settings.sources_confirm_remove': 'Êtes-vous sûr de vouloir retirer ce dossier source ?',
  'browse.title': '📁 Parcourir les dossiers',
  'browse.select': '✔ Sélectionner',
  'browse.cancel': 'Annuler',
  'browse.empty': 'Aucun sous-dossier',
  'browse.label_placeholder': 'Label (optionnel)',
  'toast.source_added': 'Dossier source ajouté',
  'toast.source_removed': 'Dossier source retiré',
  'toast.source_duplicate': 'Ce répertoire est déjà ajouté comme source',

  // ── Auto-scan ──
  'settings.autoscan_title': 'Scan automatique',
  'settings.autoscan_desc': 'Les dossiers sources sont surveillés en temps réel. Vous pouvez aussi activer un scan périodique.',
  'settings.autoscan_interval': 'Scan périodique',
  'settings.autoscan_off': 'Désactivé',
  'settings.autoscan_5': 'Toutes les 5 min',
  'settings.autoscan_15': 'Toutes les 15 min',
  'settings.autoscan_30': 'Toutes les 30 min',
  'settings.autoscan_60': 'Toutes les heures',
  'settings.autoscan_360': 'Toutes les 6 heures',
  'settings.autoscan_realtime': '⚡ Surveillance temps réel active',
  'toast.autoscan_saved': 'Scan automatique enregistré',
});
