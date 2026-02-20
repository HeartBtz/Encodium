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
  'dash.scan_title': 'Scanner les médias',
  'dash.scan_desc': 'Scanne le dossier médias et indexe les nouveaux fichiers vidéo.',
  'dash.scan_start': '▶ Démarrer le scan',
  'dash.scan_cancel': '⏹ Annuler',
  'toast.scan_started': 'Scan lancé',
  'toast.cancel_requested': 'Annulation demandée',
  'scan.progress': '{done}/{total} – {folder} ({skipped} ignorés, {errors} erreurs)',
  'scan.cancelled': 'Scan annulé',
  'scan.done': 'Terminé — {total} fichiers, {errors} erreurs',

  // ── Sync ──
  'dash.sync_title': 'Synchroniser la base',
  'dash.sync_desc': 'Supprime les entrées orphelines et ajoute les nouveaux fichiers sans tout rescanner.',
  'dash.sync_start': '🔄 Synchroniser',
  'toast.sync_started': 'Synchronisation lancée',
  'sync.progress': '{done}/{total} vérifiés — {removed} supprimé(s), {added} ajouté(s), {errors} erreurs',
  'sync.done': 'Terminé — {removed} supprimé(s), {added} ajouté(s), {errors} erreurs',

  // ── Enrich ──
  'dash.enrich_title': 'Enrichir les métadonnées',
  'dash.enrich_desc': 'Extrait codec, durée, résolution via ffprobe.',
  'dash.enrich_start': '▶ Enrichir',
  'toast.enrich_started': 'Enrichissement lancé',
  'enrich.progress': '{done}/{total} ({errors} erreurs)',
  'enrich.done': 'Terminé — {total} vidéos, {errors} erreurs',

  // ── Thumbs ──
  'dash.thumbs_title': 'Générer les miniatures',
  'dash.thumbs_desc': 'Crée les thumbnails manquantes.',
  'dash.thumbs_start': '▶ Générer',
  'toast.thumbs_started': 'Génération des miniatures lancée',
  'thumbs.progress': '{done}/{total} ({errors} erreurs)',
  'thumbs.done': 'Terminé — {total} miniatures, {errors} erreurs',

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
  'queue.encoding': 'En cours',
  'queue.pending': 'En attente',
  'queue.done': 'Terminés',
  'queue.errors': 'Erreurs',
  'queue.active_workers': 'Workers actifs : {active}/{total}',
  'queue.no_jobs': 'Aucun job d\'encodage',

  // ── Job log ──
  'toast.log_unavailable': 'Log non disponible',
  'log.empty': '(vide)',
  'log.modal_title': 'Log — Job #{id}',

  // ── SSE updates ──
  'toast.job_skipped': 'Job #{id} : {reason}',
  'toast.encoding_done': 'Encodage terminé : job #{id}',
  'toast.encoding_error': 'Erreur encodage : job #{id} – {error}',

  // ── Workers ──
  'toast.workers_set': 'Workers réglés à {count}',
  'toast.jobs_cancelled': '{n} jobs annulés',
  'toast.jobs_cleared': '{n} job(s) supprimé(s) de la file',

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
});
