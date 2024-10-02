import { App, Editor, Modal, Notice, Plugin, PluginSettingTab, setIcon, Setting, TAbstractFile, TextComponent, TFile, TFolder } from 'obsidian';
import { OAuth2Client } from 'google-auth-library'
import { drive_v3, google } from "googleapis"

type OnSubmitCallback = (value: string) => void;

interface DriveUploaderSettings {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	authorizationCode: string;
	accessToken: string;
	refreshToken: string;
	folderId: string;
	fileDirectory: string;
}

const DEFAULT_SETTINGS: DriveUploaderSettings = {
	clientId: "",
	clientSecret: "",
	redirectUri: "urn:ietf:wg:oauth:2.0:oob",
	authorizationCode: "",
	accessToken: "",
	refreshToken: "",
	folderId: "",
	fileDirectory: "."
}

const wrapTextWithPasswordHide = (text: TextComponent) => {
	const hider = text.inputEl.insertAdjacentElement("beforebegin", createSpan());
	if (!hider) {
		return
	}
	setIcon(hider as HTMLElement, 'eye-off');

	hider.addEventListener("click", () => {
		const isText = text.inputEl.getAttribute("type") === "text";
		if (isText) {
			setIcon(hider as HTMLElement, 'eye-off');
			text.inputEl.setAttribute("type", "password");
		} else {
			setIcon(hider as HTMLElement, 'eye')
			text.inputEl.setAttribute("type", "text");
		}
		text.inputEl.focus();
	});
	text.inputEl.setAttribute("type", "password");
	return text;
};

export default class DriveUploader extends Plugin {

	settings: DriveUploaderSettings;
	oauth2Client: OAuth2Client;
	isAuth: boolean;

	async onload() {

		await this.loadSettings();

		this.syncFiles();

		this.addSettingTab(new DriveUploaderSettingsTab(this.app, this));

		this.addCommand({
			id: 'drive_uploader',
			name: 'File upload',
			icon: 'upload-cloud',
			editorCallback: (editor: Editor) => {
				this.authenticateUser();
			},
		});

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				console.log("File Deleted", file.name);
				this.deleteFileFromDrive(file);
			})
		)
		this.registerEvent(this.app.workspace.on("editor-paste", this.handleUpload.bind(this)));
		this.registerEvent(this.app.workspace.on("editor-drop", this.handleUpload.bind(this)));

		if (this.settings.accessToken && this.settings.refreshToken) {
			new Notice("App is already authenticated to Google Drive")
		}
	}

	async authenticateUser() {

		const clientId = this.settings.clientId;
		const clientSecret = this.settings.clientSecret;
		const redirectUri = this.settings.redirectUri;

		if (clientId === "" || clientSecret === "") {
			new Notice('Invalid client data, please insert propper client id and client secret');
			return;
		}

		this.oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

		const authUrl = this.oauth2Client.generateAuthUrl({
			access_type: 'offline',
			scope: ['https://www.googleapis.com/auth/drive.file'],
		});

		window.open(authUrl);

		new CustomPromptModal(this.app, async (authCode: string) => {

			this.settings.authorizationCode = authCode;

			if (authCode) {
				try {
					const { tokens } = await this.oauth2Client.getToken(authCode);
					this.oauth2Client.setCredentials(tokens);

					this.settings.accessToken = tokens.access_token as string;
					this.settings.refreshToken = tokens.refresh_token as string;
					await this.saveData(this.settings);
					this.isAuth = true;

					new Notice('Authentication successful!');
				} catch (error) {
					console.error('Error authenticating with Google Drive:', error);
					new Notice('Authentication failed.');
				}
			}
		}).open();

	}

	async uploadFileToDrive(file: File) {

		console.log(file.stream())

		const clientId = this.settings.clientId;
		const clientSecret = this.settings.clientSecret;
		const redirectUri = this.settings.redirectUri;

		this.oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
		this.oauth2Client.setCredentials({
			access_token: this.settings.accessToken,
			refresh_token: this.settings.refreshToken,
		});

		const drive = google.drive({ version: 'v3', auth: this.oauth2Client })

		try {

			await drive.files.create({
				requestBody: {
					name: file.name,
					mimeType: file.type,
					parents: [this.settings.folderId]
				},
				media: {
					mimeType: file.type,
					body: file.stream(),
				},
			});

			new Notice(`Uploaded ${file.name} to Google Drive.`);

		} catch (error) {
			console.error('Error uploading to Google Drive:', error);
			new Notice('Failed to upload file to Google Drive.');
		}

	}

	async deleteFileFromDrive(file: File | TAbstractFile) {

		const clientId = this.settings.clientId;
		const clientSecret = this.settings.clientSecret;
		const redirectUri = this.settings.redirectUri;

		this.oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
		this.oauth2Client.setCredentials({
			access_token: this.settings.accessToken,
			refresh_token: this.settings.refreshToken,
		});

		const drive = google.drive({ version: 'v3', auth: this.oauth2Client });

		try {
			const driveFiles = (await drive.files.list({
				q: `'${this.settings.folderId}' in parents and trashed = false`,
				fields: 'files(id, name)'
			})).data.files as drive_v3.Schema$File[];

			const thisFile = driveFiles.find(driveFile => driveFile.name === file.name);

			drive.files.delete({
                fileId: thisFile?.id as string,
            });

			new Notice("File successfully deleted")
		} catch (error) {
			new Notice("File wasn't deleted")
		}
	}

	async handleUpload(event: DragEvent) {

		if (event.dataTransfer && event.dataTransfer.files.length > 0) {

			const files = event.dataTransfer.files;

			for (const file of Array.from(files)) {

				await this.uploadFileToDrive(file);

				const fileInVault = this.app.vault.getAbstractFileByPath(`${file.name}`)
				const filePath = `${this.settings.fileDirectory}/${file.name}`

				if (fileInVault) {
					try {
						await this.app.vault.rename(fileInVault, filePath);
					} catch (error) {
						console.error("Error moving the file:", error);
					}
				}
			}
		}
	}

	async syncFiles() {

		console.log("sync_run")

		const clientId = this.settings.clientId;
		const clientSecret = this.settings.clientSecret;
		const redirectUri = this.settings.redirectUri;

		this.oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
		this.oauth2Client.setCredentials({
			access_token: this.settings.accessToken,
			refresh_token: this.settings.refreshToken,
		});

		const drive = google.drive({ version: 'v3', auth: this.oauth2Client });
		const driveFiles = (await drive.files.list({
			q: `'${this.settings.folderId}' in parents and trashed = false`,
			fields: 'files(id, name)'
		})).data.files as drive_v3.Schema$File[];

		const vaultFiles = this.listFilesInFolder(this.settings.fileDirectory);

		for (const file of vaultFiles) {
			if (!driveFiles.find(driveFile => driveFile.name === file.name)) {
				console.log("noticed");
				const fileContents = await this.app.vault.read(file);
				const blob = new Blob([fileContents], { type: this.getMimeType(file)});
				const convertedFile = new File([blob], file.name, { type: blob.type, lastModified: file.stat.mtime });
				this.uploadFileToDrive(convertedFile);
			}
		}
	}

	private listFilesInFolder(folderPath: string) {

		const folder = this.app.vault.getAbstractFileByPath(folderPath);

		if (folder && folder instanceof TFolder) {
			const files: TFile[] = [];

			folder.children.forEach((item) => {
				if (item instanceof TFile) {
					files.push(item);
					console.log(`File: ${item.path}`);
				}
			});

			return files;
		} else {
			console.error("The specified folder does not exist or is not a folder.");
			return [];
		}
	}

	private getMimeType(tfile: TFile): string {

		const extension = tfile.extension.toLowerCase();
	
		const mimeTypes: Record<string, string> = {
			"txt": "text/plain",
			"md": "text/markdown",
			"html": "text/html",
			"css": "text/css",
			"js": "application/javascript",
			"json": "application/json",
			"xml": "application/xml",
			"jpg": "image/jpeg",
			"jpeg": "image/jpeg",
			"png": "image/png",
			"gif": "image/gif",
			"svg": "image/svg+xml",
			"pdf": "application/pdf",
			"zip": "application/zip",
			"rar": "application/vnd.rar",
			"mp3": "audio/mpeg",
			"mp4": "video/mp4",
		};
	
		return mimeTypes[extension] || "application/octet-stream"; 
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class DriveUploaderSettingsTab extends PluginSettingTab {

	plugin: DriveUploader;

	constructor(app: App, plugin: DriveUploader) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {

		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Client Id')
			.setDesc("Required")
			.addText(text => {
				wrapTextWithPasswordHide(text)
				return text.setPlaceholder('Enter your client id')
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value;
						await this.plugin.saveSettings();
					})
			});

		new Setting(containerEl)
			.setName('Client Secret')
			.setDesc("Required")
			.addText(text => {
				wrapTextWithPasswordHide(text)
				return text.setPlaceholder('Enter your secret')
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value;
						await this.plugin.saveSettings();
					})
			});

		new Setting(containerEl)
			.setName('Folder Id')
			.setDesc("Optional")
			.addText(text => {
				wrapTextWithPasswordHide(text)
				return text.setPlaceholder('Enter your folder id')
					.setValue(this.plugin.settings.folderId)
					.onChange(async (value) => {
						this.plugin.settings.folderId = value;
						await this.plugin.saveSettings();
					})
			});

		new Setting(containerEl)
			.setName('File Directory')
			.setDesc("Optional")
			.addText(text => {
				wrapTextWithPasswordHide(text)
				return text.setPlaceholder('Enter your file directory')
					.setValue(this.plugin.settings.fileDirectory)
					.onChange(async (value) => {
						this.plugin.settings.fileDirectory = value;
						await this.plugin.saveSettings();
					})
			});
	}
}

class CustomPromptModal extends Modal {

	private onSubmit: OnSubmitCallback;

	constructor(app: App, onSubmit: OnSubmitCallback) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Enter your Google authorization code:" });
		const inputEl = contentEl.createEl("input", {
			type: "text",
			placeholder: "Paste your code here...",
		});
		const submitButton = contentEl.createEl("button", { text: "Submit" });
		submitButton.addEventListener("click", () => {
			this.onSubmit(inputEl.value);
			this.close();
		});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}
