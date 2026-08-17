package model

type User struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Nickname    string `json:"nickname"`
	CreatedAtMs int64  `json:"createdAtMs"`
}

type Identity struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
	RoomID   string `json:"roomId,omitempty"`
	Guest    bool   `json:"guest"`
}

type Room struct {
	ID          string  `json:"id"`
	Code        string  `json:"code"`
	Title       string  `json:"title"`
	HostUserID  string  `json:"hostUserId"`
	Status      string  `json:"status"`
	JoinPolicy  string  `json:"joinPolicy"`
	MediaID     *string `json:"mediaId,omitempty"`
	MaxMembers  int     `json:"maxMembers"`
	CreatedAtMs int64   `json:"createdAtMs"`
	UpdatedAtMs int64   `json:"updatedAtMs"`
	ClosedAtMs  *int64  `json:"closedAtMs,omitempty"`
}

type Member struct {
	ID, Nickname, Role, Kind string
	JoinedAtMs               int64
	Online, Ready            bool
}

type Media struct {
	ID               string `json:"id"`
	OwnerUserID      string `json:"ownerUserId"`
	ObjectKey        string `json:"-"`
	OriginalFilename string `json:"originalFilename"`
	MIMEType         string `json:"mimeType"`
	Status           string `json:"status"`
	SizeBytes        int64  `json:"sizeBytes"`
	CreatedAtMs      int64  `json:"createdAtMs"`
	UpdatedAtMs      int64  `json:"updatedAtMs"`
	DurationMs       *int64 `json:"durationMs,omitempty"`
	VideoWidth       *int   `json:"videoWidth,omitempty"`
	VideoHeight      *int   `json:"videoHeight,omitempty"`
}

type Upload struct {
	ID, MediaID, Mode, Status string
	S3UploadID                *string
	CreatedAtMs, ExpiresAtMs  int64
}

type Invite struct {
	ID, RoomID, CreatedBy  string
	ExpiresAtMs            *int64
	MaxUses                *int
	UsedCount, CreatedAtMs int64
}

type ChatMessage struct {
	ID              string `json:"id"`
	RoomID          string `json:"roomId"`
	SenderID        string `json:"senderId"`
	SenderNickname  string `json:"senderNickname"`
	SenderKind      string `json:"senderKind"`
	Content         string `json:"content"`
	MediaPositionMs *int64 `json:"mediaPositionMs,omitempty"`
	CreatedAtMs     int64  `json:"createdAtMs"`
}

type Checkpoint struct {
	RoomID                  string
	MediaID                 *string
	PositionMs, UpdatedAtMs int64
	PlaybackRate            float64
	Phase                   string
}
