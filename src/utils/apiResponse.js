class ApiResponse {
    static success(res, data, message = 'Success', statusCode = 200) {
        return res.status(statusCode).json({
            success: true,
            message,
            data
        });
    }

    static error(res, message = 'Error', statusCode = 500, errors = null) {
        const response = {
            success: false,
            message
        };

        if (errors) {
            response.errors = errors;
        }

        return res.status(statusCode).json(response);
    }

    static paginate(res, data, pagination, message = 'Success') {
        return res.status(200).json({
            success: true,
            message,
            count: data.length,
            ...pagination,
            data
        });
    }
}

module.exports = ApiResponse;
