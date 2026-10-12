package s3store

import (
	"context"
	"errors"
	"time"

	smithyhttp "github.com/aws/smithy-go/transport/http"
)

type Health struct {
	Status    string `json:"status"`
	Message   string `json:"message"`
	LatencyMs int64  `json:"latencyMs"`
}

// CheckHealth is a bounded, read-only bucket access check. It does not assert
// browser CORS access or object write permission and never returns credentials.
func CheckHealth(ctx context.Context, objects ObjectStore) Health {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	start := time.Now()
	err := ErrNotConfigured
	if objects != nil {
		err = objects.Doctor(ctx)
	}
	result := Health{Status: "ok", Message: "OSS 存储桶连接正常；浏览器直传仍需正确配置 CORS 和上传权限", LatencyMs: time.Since(start).Milliseconds()}
	if err == nil {
		return result
	}
	result.Status = "unavailable"
	result.Message = "OSS 不可用，请检查 Endpoint、区域、网络及 S3 兼容配置"
	var response *smithyhttp.ResponseError
	switch {
	case errors.Is(err, ErrNotConfigured):
		result.Status, result.Message = "not_configured", "OSS 未配置，请设置存储桶及访问凭证"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(ctx.Err(), context.DeadlineExceeded):
		result.Status, result.Message = "timeout", "OSS 检测超时，请检查服务器到对象存储的网络"
	case errors.As(err, &response):
		switch response.HTTPStatusCode() {
		case 401, 403:
			result.Status, result.Message = "access_denied", "OSS 拒绝访问，请检查凭证、签名区域和存储桶访问权限"
		case 404:
			result.Status, result.Message = "bucket_not_found", "OSS 存储桶不存在或 Endpoint/区域不匹配"
		}
	}
	return result
}
